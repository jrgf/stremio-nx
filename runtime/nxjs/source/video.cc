// Video element native bindings.
//
// PORTABLE (compiled into both the device runtime and the host nxjs-test
// binary). The heavy lifting lives in media-decoder.cc (ffmpeg demux/decode
// on a dedicated thread); this module is the V8 glue plus the drawImage
// integration.
//
// drawImage integration: nx_video_t embeds an nx_image_t as its FIRST member,
// making a Video JS object directly drawable by canvas.cc (which unwraps any
// wrapped object as nx_image_t — width/height/premul-BGRA `data` + the
// SkImage cache slot). Each presented frame pointer-swaps into `image.data`
// and drops the SkImage memo, exactly like the IR sensor's per-frame path.
#include "video.h"
#include "async.h"
#include "audio-graph.h"
#include "audio.h"
#include "error.h"
#include "image.h"
#include "media-decoder.h"
#include "media-source.h"
#include <map>
#include <stdint.h>
#include "util.h"
#include "wrap.h"
#include <stdlib.h>
#include <string.h>

using namespace v8;

namespace {

struct nx_video_t {
	// MUST be first: canvas.cc draws any wrapped object as an nx_image_t.
	nx_image_t image;
	nx_media_t *media = nullptr;
	int source_id = 0; // registry id of the media source backing this video (0=none)
	// Stream-source node owned by this video (released on close, AFTER the
	// decode thread is joined). NULL when the media has no audio track or no
	// audio context was attached.
	nx_audio_node *audio_node = nullptr;
	bool closed = false;
	uint64_t load_seq = 0;
	int loading_source_id = 0;
	int max_width = 0, max_height = 0;
};

// Media-source registry (defined below, used by reset_media/load).
void ms_addref(int id);
void ms_release(int id);
nx_media_source *ms_lookup(int id);

// Tear down the current media (joins the decode thread) so the handle can be
// reloaded with a new source. Safe to call with nothing loaded.
void reset_media(nx_video_t *v) {
	++v->load_seq;
	if (auto *source = ms_lookup(v->loading_source_id)) nx_media_source_close(source);
	v->loading_source_id = 0;
	if (v->media) {
		nx_media_destroy(v->media); // joins the decode thread
		v->media = nullptr;
	}
	if (v->source_id) {
		ms_release(v->source_id); // safe now: decoder no longer reads it
		v->source_id = 0;
	}
	if (v->audio_node) {
		// Released strictly after the decode thread is gone.
		nx_audio_node_release(v->audio_node);
		v->audio_node = nullptr;
	}
	nx_image_release_cache(&v->image);
	nx_image_release_gpu(&v->image);
	free(v->image.data);
	v->image.data = nullptr;
	v->image.width = v->image.height = 0;
	v->image.logical_width = v->image.logical_height = 0;
}

void close_video(nx_video_t *v) {
	if (v->closed)
		return;
	v->closed = true;
	reset_media(v);
}

void free_video(nx_video_t *v) {
	close_video(v);
	delete v;
}

nx_video_t *get_video(Isolate *iso, Local<Value> val) {
	nx_video_t *v = nx::Unwrap<nx_video_t>(val);
	if (!v)
		nx_throw(iso, "expected Video handle");
	return v;
}

double arg_f64(const FunctionCallbackInfo<Value> &info, int i) {
	double v = 0;
	if (!info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).To(&v))
		v = 0;
	return v;
}

struct ms_entry {
	nx_media_source *src;
	int refcount;
};
std::map<int, ms_entry> g_media_sources; // main-thread only
int g_next_source_id = 1;

nx_media_source *ms_lookup(int id) {
	auto it = g_media_sources.find(id);
	return it == g_media_sources.end() ? nullptr : it->second.src;
}
void ms_addref(int id) {
	auto it = g_media_sources.find(id);
	if (it != g_media_sources.end())
		it->second.refcount++;
}
void ms_release(int id) {
	auto it = g_media_sources.find(id);
	if (it == g_media_sources.end())
		return;
	if (--it->second.refcount <= 0) {
		nx_media_source_free(it->second.src);
		g_media_sources.erase(it);
	}
}

void nx_video_new(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	Local<Object> obj = nx::NewWrapped(iso);
	nx_video_t *v = new nx_video_t();
	memset(&v->image, 0, sizeof(v->image));
	v->image.magic = NX_IMAGE_MAGIC;
	v->image.format = FORMAT_UNKNOWN;
	nx::Wrap<nx_video_t>(iso, obj, v, free_video);
	info.GetReturnValue().Set(obj);
}

// ---------------------------------------------------------------------------
// videoLoad(video, path | null, buffer | null) -> Promise<metadata>
// ---------------------------------------------------------------------------

struct video_load_t {
	int max_width = 0, max_height = 0;
	nx_video_t *video = nullptr;
	uint64_t seq = 0;
	Global<Value> video_val; // pins the wrapper during the load
	char *path = nullptr;    // owned copy (file-backed load)
	const uint8_t *mem = nullptr;
	size_t mem_size = 0;
	nx_media_source *source = nullptr;
	int source_id = 0;
	// Strong ref to the memory buffer for the duration of the open (and,
	// via nx_media_open, handed to the media for its whole lifetime) — a
	// concurrent reset/close on the main thread can never unpin it.
	std::shared_ptr<BackingStore> mem_store;
	nx_media_t *media = nullptr;
	char err_buf[256] = {};
	~video_load_t() { free(path); }
};

void video_load_work(nx_work_t *req) {
	video_load_t *data = (video_load_t *)req->data;
	data->media =
	    nx_media_open(data->path, data->mem, data->mem_size, data->source,
	                  data->mem_store, data->err_buf, sizeof(data->err_buf), data->max_width, data->max_height);
}

MaybeLocal<Value> video_load_after(Isolate *iso, nx_work_t *req) {
	Local<Context> context = iso->GetCurrentContext();
	video_load_t *data = (video_load_t *)req->data;
	nx_video_t *v = data->video;
	data->video_val.Reset();
	if (v->load_seq == data->seq) v->loading_source_id = 0;
	if (!data->media) {
		if (data->source_id)
			ms_release(data->source_id);
		iso->ThrowException(Exception::Error(nx_str_lossy(iso, data->err_buf)));
		return MaybeLocal<Value>();
	}
	if (v->closed || v->load_seq != data->seq) {
		// The video was closed while the open was in flight.
		nx_media_destroy(data->media);
		if (data->source_id)
			ms_release(data->source_id);
		iso->ThrowException(Exception::Error(nx_str(iso, "Video was closed")));
		return MaybeLocal<Value>();
	}
	// Only the most recently requested load may install its decoder.
	v->media = data->media;
	v->source_id = data->source_id; // transfer the addref taken at load time
	int width = nx_media_render_width(data->media);
	int height = nx_media_render_height(data->media);
	if (nx_media_has_video(data->media)) {
		uint8_t *buf = (uint8_t *)nx_alloc(iso, (size_t)width * height * 4);
		if (!buf) {
			nx_media_destroy(v->media);
			v->media = nullptr;
			return MaybeLocal<Value>();
		}
		memset(buf, 0, (size_t)width * height * 4);
		// Opaque black until the first frame presents.
		for (size_t i = 3; i < (size_t)width * height * 4; i += 4)
			buf[i] = 0xff;
		v->image.width = (uint32_t)width;
		v->image.height = (uint32_t)height;
		v->image.logical_width = nx_media_width(data->media);
		v->image.logical_height = nx_media_height(data->media);
		v->image.data = buf;
		v->image.streaming = true; // one persistent GPU texture, updated per frame
		v->image.gpu_dirty = true;
	}
	Local<Object> result = Object::New(iso);
	result->Set(context, nx_str(iso, "width"), Integer::New(iso, nx_media_width(data->media)))
	    .Check();
	result->Set(context, nx_str(iso, "height"), Integer::New(iso, nx_media_height(data->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "duration"),
	          Number::New(iso, nx_media_duration(data->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "hasAudio"),
	          Boolean::New(iso, nx_media_has_audio(data->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "hasVideo"),
	          Boolean::New(iso, nx_media_has_video(data->media)))
	    .Check();
	return result.As<Value>();
}

void nx_video_load(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v)
		return;
	if (v->closed) {
		nx_throw(iso, "Video was closed");
		return;
	}
	reset_media(v); // support changing `src`
	NX_INIT_WORK_T_CPP(video_load_t);
	data->video = v;
	data->seq = v->load_seq;
	data->max_width = v->max_width;
	data->max_height = v->max_height;
	data->video_val.Reset(iso, info[0]);
	if (info[1]->IsString()) {
		String::Utf8Value path(iso, info[1]);
		if (*path && strncmp(*path, "nxms:", 5) == 0) {
			int id = atoi(*path + 5);
			nx_media_source *src = ms_lookup(id);
			if (!src) {
				req->data_dtor(data);
				delete req;
				nx_throw(iso, "unknown media source");
				return;
			}
			v->loading_source_id = id;
			ms_addref(id);
			data->source = src;
			data->source_id = id;
		} else if (*path) {
			data->path = strdup(*path);
		}
	} else if (info[2]->IsArrayBuffer()) {
		Local<ArrayBuffer> ab = info[2].As<ArrayBuffer>();
		std::shared_ptr<BackingStore> bs = ab->GetBackingStore();
		data->mem = (const uint8_t *)bs->Data();
		data->mem_size = bs->ByteLength();
		data->mem_store = std::move(bs);
	}
	if (!data->path && !data->mem && !data->source) {
		req->data_dtor(data);
		delete req;
		nx_throw(iso, "expected a path string or ArrayBuffer");
		return;
	}
	info.GetReturnValue().Set(
	    nx_queue_async(iso, req, video_load_work, video_load_after));
}

// ---------------------------------------------------------------------------
// Transport + presentation
// ---------------------------------------------------------------------------

void nx_video_play(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (v && v->media)
		nx_media_play(v->media);
}

void nx_video_pause(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (v && v->media)
		nx_media_pause(v->media);
}

void nx_video_seek(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (v && v->media)
		nx_media_seek(v->media, arg_f64(info, 1));
}

void nx_video_set_loop(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (v && v->media)
		nx_media_set_loop(v->media, info[1]->BooleanValue(iso));
}

void nx_video_tracks(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	Local<Context> context = iso->GetCurrentContext();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v) return;
	Local<Array> result = Array::New(iso);
	if (v->media) {
		bool subtitle = info[1]->BooleanValue(iso);
		uint32_t index = 0;
		for (const auto &track : nx_media_tracks(v->media)) {
			if (track.subtitle != subtitle) continue;
			Local<Object> item = Object::New(iso);
			item->Set(context, nx_str(iso, "id"), Integer::New(iso, track.id)).Check();
			item->Set(context, nx_str(iso, "supported"), Boolean::New(iso, track.supported)).Check();
			item->Set(context, nx_str(iso, "language"), nx_str_lossy(iso, track.language.c_str())).Check();
			item->Set(context, nx_str(iso, "label"), nx_str_lossy(iso, track.label.c_str())).Check();
			item->Set(context, nx_str(iso, "codec"), nx_str(iso, track.codec.c_str())).Check();
			result->Set(context, index++, item).Check();
		}
	}
	info.GetReturnValue().Set(result);
}

void nx_video_select_track(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	int id;
	if (!v || !info[1]->Int32Value(iso->GetCurrentContext()).To(&id)) return;
	if (!v->media || !nx_media_select_track(v->media, id, info[2]->BooleanValue(iso)))
		nx_throw(iso, "Unsupported or unknown media track");
}

void nx_video_subtitle_text(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v) return;
	std::string text = v->media ? nx_media_subtitle_text(v->media, arg_f64(info, 1)) : "";
	info.GetReturnValue().Set(nx_str_lossy(iso, text.c_str()));
}

void nx_video_set_render_size(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v) return;
	if (!info[1]->IsInt32() || !info[2]->IsInt32()) { nx_throw(iso, "Invalid video render bounds"); return; }
	const int width = info[1].As<Int32>()->Value(), height = info[2].As<Int32>()->Value();
	if (width <= 0 || height <= 0 || width > 4096 || height > 4096 || v->media || v->loading_source_id) {
		nx_throw(iso, "Set video render bounds before loading a source"); return;
	}
	v->max_width = width;
	v->max_height = height;
}

void nx_video_frame_stats(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v) return;
	double transfer = 0, convert = 0;
	if (v->media) nx_media_frame_times(v->media, &transfer, &convert);
	Local<Context> context = iso->GetCurrentContext();
	Local<Object> result = Object::New(iso);
	result->Set(context, nx_str(iso, "width"), Integer::NewFromUnsigned(iso, v->image.width)).Check();
	result->Set(context, nx_str(iso, "height"), Integer::NewFromUnsigned(iso, v->image.height)).Check();
	result->Set(context, nx_str(iso, "transferMs"), Number::New(iso, transfer)).Check();
	result->Set(context, nx_str(iso, "convertMs"), Number::New(iso, convert)).Check();
	info.GetReturnValue().Set(result);
}

// videoTick(video) -> boolean (a new frame was presented)
void nx_video_tick(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v || !v->media || !v->image.data)
		return;
	if (nx_media_present(v->media, &v->image.data)) {
		nx_image_release_cache(&v->image);
		info.GetReturnValue().Set(true);
	} else {
		info.GetReturnValue().Set(false);
	}
}

// videoState(video) -> { currentTime, ended, seeking, buffered, error? }
void nx_video_state(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	Local<Context> context = iso->GetCurrentContext();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v || !v->media)
		return;
	Local<Object> result = Object::New(iso);
	result
	    ->Set(context, nx_str(iso, "currentTime"),
	          Number::New(iso, nx_media_current_time(v->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "ended"),
	          Boolean::New(iso, nx_media_ended(v->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "seeking"),
	          Boolean::New(iso, nx_media_seeking(v->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "buffered"),
	          Integer::NewFromUnsigned(iso,
	                                   nx_media_buffered_frames(v->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "presentedFrames"),
	          Number::New(iso, (double)nx_media_presented_frames(v->media)))
	    .Check();
	result
	    ->Set(context, nx_str(iso, "droppedFrames"),
	          Number::New(iso, (double)nx_media_dropped_frames(v->media)))
	    .Check();
	const char *err = nx_media_error(v->media);
	result->Set(context, nx_str(iso, "decoder"), nx_str(iso, nx_media_video_decoder(v->media))).Check();
	result->Set(context, nx_str(iso, "audioTrack"), Integer::New(iso, nx_media_audio_track(v->media))).Check();
	result->Set(context, nx_str(iso, "subtitleTrack"), Integer::New(iso, nx_media_subtitle_track(v->media))).Check();
	std::string track_error = nx_media_track_error(v->media);
	if (!track_error.empty()) result->Set(context, nx_str(iso, "trackError"), nx_str_lossy(iso, track_error.c_str())).Check();
	if (err) {
		result->Set(context, nx_str(iso, "error"), nx_str_lossy(iso, err))
		    .Check();
	}
	info.GetReturnValue().Set(result);
}

// videoCreateAudioNode(video, audioCtxHandle) -> stream node handle
//
// The returned wrapper has NO finalizer: the node's lifetime is owned by the
// video (released in close_video, strictly after the decode thread joins, so
// the producer can never touch a freed node). The JS Video element keeps both
// objects alive together.
void nx_video_create_audio_node(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (!v)
		return;
	nx_audio_ctx_t *ctx = nx::Unwrap<nx_audio_ctx_t>(info[1]);
	if (!ctx) {
		nx_throw(iso, "expected AudioContext handle");
		return;
	}
	if (!v->media || !nx_media_has_audio(v->media) || v->audio_node) {
		info.GetReturnValue().SetNull();
		return;
	}
	nx_audio_node *node =
	    nx_audio_node_create(ctx->graph, NX_AUDIO_NODE_STREAM_SOURCE);
	v->audio_node = node;
	nx_media_set_audio_node(v->media, node, ctx->graph->sample_rate);
	Local<Object> obj = nx::NewWrapped(iso);
	obj->SetAlignedPointerInInternalField(0, node,
	                                      kEmbedderDataTypeTagDefault);
	info.GetReturnValue().Set(obj);
}

void nx_video_close(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	nx_video_t *v = get_video(iso, info[0]);
	if (v)
		close_video(v);
}

void nx_video_reset(const FunctionCallbackInfo<Value> &info) {
	if (auto *v = get_video(info.GetIsolate(), info[0])) reset_media(v);
}

// ---------------------------------------------------------------------------
// MediaSource: JS pushes bytes, a source-backed Video decodes them. See
// media-source.{h,cc}. Registry + refcount live above (ms_lookup/addref/release).
// ---------------------------------------------------------------------------

int64_t arg_i64(const FunctionCallbackInfo<Value> &info, int i) {
	double v = 0;
	if (!info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).To(&v))
		v = 0;
	return (int64_t)v;
}

void nx_media_source_new_js(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	int64_t size = arg_i64(info, 0);
	if (size < 0)
		size = 0;
	int id = g_next_source_id++;
	g_media_sources[id] = ms_entry{nx_media_source_new(size), 1};
	info.GetReturnValue().Set(Integer::New(iso, id));
}

void nx_media_source_provide_js(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	int id = 0;
	if (!info[0]->Int32Value(iso->GetCurrentContext()).To(&id))
		return;
	nx_media_source *src = ms_lookup(id);
	if (!src)
		return;
	int64_t offset = arg_i64(info, 1);
	size_t len = 0;
	uint8_t *data = NX_GetBufferSource(iso, &len, info[2]);
	if (!data) {
		nx_throw(iso, "expected ArrayBuffer");
		return;
	}
	nx_media_source_provide(src, offset, data, len);
}

void nx_media_source_wanted_js(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	int id = 0;
	if (!info[0]->Int32Value(iso->GetCurrentContext()).To(&id))
		return;
	nx_media_source *src = ms_lookup(id);
	info.GetReturnValue().Set(
	    Number::New(iso, src ? (double)nx_media_source_wanted(src) : -1));
}

void nx_media_source_position_js(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	int id = 0;
	if (!info[0]->Int32Value(iso->GetCurrentContext()).To(&id))
		return;
	nx_media_source *src = ms_lookup(id);
	info.GetReturnValue().Set(
	    Number::New(iso, src ? (double)nx_media_source_position(src) : 0));
}

void nx_media_source_buffered_js(const FunctionCallbackInfo<Value> &info) {
	Isolate *iso = info.GetIsolate();
	int id = 0;
	if (!info[0]->Int32Value(iso->GetCurrentContext()).To(&id))
		return;
	nx_media_source *src = ms_lookup(id);
	info.GetReturnValue().Set(Number::New(
	    iso, src ? (double)nx_media_source_buffered(src, arg_i64(info, 1)) : 0));
}

void nx_media_source_discard_before_js(const FunctionCallbackInfo<Value> &info) {
	int id = 0;
	if (!info[0]->Int32Value(info.GetIsolate()->GetCurrentContext()).To(&id))
		return;
	nx_media_source *src = ms_lookup(id);
	if (src)
		nx_media_source_discard_before(src, arg_i64(info, 1));
}

void nx_media_source_close_js(const FunctionCallbackInfo<Value> &info) {
	int id = 0;
	if (!info[0]->Int32Value(info.GetIsolate()->GetCurrentContext()).To(&id))
		return;
	nx_media_source *src = ms_lookup(id);
	if (src)
		nx_media_source_close(src); // wake a blocked decoder
	ms_release(id);                 // drop the JS reference
}

void nx_media_source_retain_js(const FunctionCallbackInfo<Value> &info) {
	int id = 0;
	if (!info[0]->Int32Value(info.GetIsolate()->GetCurrentContext()).To(&id)) return;
	if (auto *src = ms_lookup(id)) nx_media_source_retain(src, arg_i64(info, 1), arg_i64(info, 2), info.Length() > 3 ? arg_i64(info, 3) : 0);
}

void nx_media_source_stored_js(const FunctionCallbackInfo<Value> &info) {
	int id = 0;
	if (!info[0]->Int32Value(info.GetIsolate()->GetCurrentContext()).To(&id)) return;
	auto *src = ms_lookup(id);
	info.GetReturnValue().Set(Number::New(info.GetIsolate(), src ? (double)nx_media_source_stored(src) : 0));
}

} // namespace

void nx_init_video(Isolate *iso, Local<Object> init_obj) {
	NX_SET_FUNC(init_obj, "videoNew", nx_video_new);
	NX_SET_FUNC(init_obj, "videoLoad", nx_video_load);
	NX_SET_FUNC(init_obj, "videoSetRenderSize", nx_video_set_render_size);
	NX_SET_FUNC(init_obj, "videoFrameStats", nx_video_frame_stats);
	NX_SET_FUNC(init_obj, "videoPlay", nx_video_play);
	NX_SET_FUNC(init_obj, "videoPause", nx_video_pause);
	NX_SET_FUNC(init_obj, "videoSeek", nx_video_seek);
	NX_SET_FUNC(init_obj, "videoTracks", nx_video_tracks);
	NX_SET_FUNC(init_obj, "videoSelectTrack", nx_video_select_track);
	NX_SET_FUNC(init_obj, "videoSubtitleText", nx_video_subtitle_text);
	NX_SET_FUNC(init_obj, "videoSetLoop", nx_video_set_loop);
	NX_SET_FUNC(init_obj, "videoTick", nx_video_tick);
	NX_SET_FUNC(init_obj, "videoState", nx_video_state);
	NX_SET_FUNC(init_obj, "videoCreateAudioNode", nx_video_create_audio_node);
	NX_SET_FUNC(init_obj, "videoClose", nx_video_close);
	NX_SET_FUNC(init_obj, "videoReset", nx_video_reset);
	NX_SET_FUNC(init_obj, "mediaSourceNew", nx_media_source_new_js);
	NX_SET_FUNC(init_obj, "mediaSourceProvide", nx_media_source_provide_js);
	NX_SET_FUNC(init_obj, "mediaSourceWanted", nx_media_source_wanted_js);
	NX_SET_FUNC(init_obj, "mediaSourcePosition", nx_media_source_position_js);
	NX_SET_FUNC(init_obj, "mediaSourceBuffered", nx_media_source_buffered_js);
	NX_SET_FUNC(init_obj, "mediaSourceDiscardBefore", nx_media_source_discard_before_js);
	NX_SET_FUNC(init_obj, "mediaSourceClose", nx_media_source_close_js);
	NX_SET_FUNC(init_obj, "mediaSourceRetain", nx_media_source_retain_js);
	NX_SET_FUNC(init_obj, "mediaSourceStored", nx_media_source_stored_js);
}
