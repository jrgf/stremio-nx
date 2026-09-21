import { $, type AudioNodeHandle, type VideoHandle, type VideoMetadata, type VideoMediaTrack } from './$';
import { getSharedAudioContext } from './audio';
import { ctxInternal, nodeInternal } from './audio/internal';
import { DOMException } from './dom-exception';
import { ErrorEvent, Event } from './polyfills/event';
import { EventTarget } from './polyfills/event-target';
import { URL } from './polyfills/url';
import { clearInterval, setInterval } from './timers';
import { createInternal, def, proto } from './utils';
import type { GainNode } from './audio/gain-node';

const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

// URL schemes the native decoder can stream directly from the filesystem.
const FILE_SCHEMES = new Set(['romfs:', 'sdmc:', 'file:', 'nxjs:', 'nxms:']);
// Schemes the native decoder streams over the network with HTTP range
// requests. Anything else (https/blob/data) is fetched fully into memory first.
const STREAM_SCHEMES = new Set(['http:']);

interface VideoInternal {
	src: string;
	currentSrc: string;
	loadSeq: number; // invalidates in-flight loads when `src` changes
	metadata: VideoMetadata | null;
	readyState: number;
	paused: boolean;
	ended: boolean;
	loop: boolean;
	volume: number;
	muted: boolean;
	seeking: boolean;
	gain: GainNode | null;
	streamNode: AudioNodeHandle | null;
	tickInterval: ReturnType<typeof setInterval> | null;
	lastTimeupdate: number;
	canplayFired: boolean;
	errorFired: boolean;
	// `play()` promises issued before metadata loaded — settled when
	// playback actually begins (or rejected on load failure / pause() /
	// a superseding load).
	pendingPlays: PromiseWithResolvers<void>[];
}

const _ = createInternal<Video, VideoInternal>();

function handleOf(v: Video): VideoHandle {
	return v as unknown as VideoHandle;
}

function selectTrack(v: Video, id: number, subtitle: boolean): void {
	const i = _(v);
	if (!i.metadata) throw new DOMException('Video metadata is not loaded.', 'InvalidStateError');
	if (!Number.isInteger(id) || id < -1 || id > 0x7fffffff) throw new TypeError('Invalid track ID.');
	$.videoSelectTrack(handleOf(v), id, subtitle);
	i.seeking = true;
	i.ended = false;
	v.dispatchEvent(new Event('seeking'));
	startTicking(v);
}

function applyVolume(v: Video) {
	const i = _(v);
	if (i.gain) {
		i.gain.gain.value = i.muted ? 0 : i.volume;
	}
}

// Settle any `play()` promises that were issued before metadata loaded:
// resolve them when playback begins, or reject them all with `error`.
function settlePendingPlays(i: VideoInternal, error?: unknown) {
	const pending = i.pendingPlays;
	if (pending.length === 0) return;
	i.pendingPlays = [];
	for (const p of pending) {
		if (error) p.reject(error);
		else p.resolve();
	}
}

// The presentation pump: while playing (or converging on a seek) advance the
// video by one tick per host frame-ish interval — presenting due frames into
// the drawable image buffer and surfacing state changes as events.
function startTicking(v: Video) {
	const i = _(v);
	if (i.tickInterval !== null) return;
	i.tickInterval = setInterval(() => tick(v), 16);
}

function stopTicking(v: Video) {
	const i = _(v);
	if (i.tickInterval !== null) {
		clearInterval(i.tickInterval);
		i.tickInterval = null;
	}
}

function tick(v: Video) {
	const i = _(v);
	if (!i.metadata) return;
	$.videoTick(handleOf(v));
	const state = $.videoState(handleOf(v));
	if (!state) return;

	if (state.error && !i.errorFired) {
		i.errorFired = true;
		stopTicking(v);
		$.videoPause(handleOf(v));
		i.paused = true;
		v.dispatchEvent(
			new ErrorEvent('error', { error: new Error(state.error) }),
		);
		return;
	}

	// readyState progression + canplay events.
	if (!i.canplayFired && (state.buffered >= 2 || state.ended)) {
		i.canplayFired = true;
		i.readyState = HAVE_ENOUGH_DATA;
		v.dispatchEvent(new Event('canplay'));
		v.dispatchEvent(new Event('canplaythrough'));
	}

	// Seek completion.
	if (i.seeking && !state.seeking) {
		i.seeking = false;
		v.dispatchEvent(new Event('seeked'));
		if (i.paused) {
			// Present the seeked frame, then stop pumping.
			$.videoTick(handleOf(v));
			stopTicking(v);
		}
	}

	if (!i.paused) {
		const now = state.currentTime;
		if (Math.abs(now - i.lastTimeupdate) >= 0.25) {
			i.lastTimeupdate = now;
			v.dispatchEvent(new Event('timeupdate'));
		}
		if (state.ended && !i.ended) {
			i.ended = true;
			i.paused = true;
			stopTicking(v);
			$.videoPause(handleOf(v));
			v.dispatchEvent(new Event('ended'));
		}
	} else if (!i.seeking && i.canplayFired) {
		// Paused, buffered, nothing in flight — stop pumping (play()/seeks
		// restart the interval).
		stopTicking(v);
	}
}

/**
 * The `Video` class provides video playback functionality similar to the
 * [`HTMLVideoElement`](https://developer.mozilla.org/docs/Web/API/HTMLVideoElement)
 * in web browsers. Since nx.js has no DOM, the video does not render itself —
 * the application explicitly draws the current frame each render pass, just
 * like drawing a `<video>` onto a `<canvas>`:
 *
 * ```typescript
 * const ctx = screen.getContext('2d');
 * const video = new Video();
 * video.loop = true;
 * video.src = 'romfs:/attract.webm';
 * video.play(); // queued until metadata loads, like in browsers
 *
 * function render() {
 *   ctx.drawImage(video, 0, 0, screen.width, screen.height);
 *   requestAnimationFrame(render);
 * }
 * requestAnimationFrame(render);
 * ```
 *
 * ### Supported Video Formats
 *
 * Any container/codec supported by [FFmpeg](https://ffmpeg.org)'s installed
 * decoders, e.g. WebM (VP8/VP9), MP4/MKV (H.264/H.265), and AV1 — with audio
 * tracks (Vorbis, Opus, AAC, MP3, …) played through the Web Audio engine,
 * synchronized to the audio clock.
 *
 * > [!NOTE]
 * > Video decoding prefers the Switch's NVDEC engine through NVTEGRA, with
 * > software fallback for unsupported streams. Frame transfer and CPU color
 * > conversion feed the canvas renderer. Check `decoder` for the active backend.
 */
export class Video extends EventTarget {
	declare onloadedmetadata: ((this: Video, ev: Event) => any) | null;
	declare oncanplay: ((this: Video, ev: Event) => any) | null;
	declare oncanplaythrough: ((this: Video, ev: Event) => any) | null;
	declare onplay: ((this: Video, ev: Event) => any) | null;
	declare onpause: ((this: Video, ev: Event) => any) | null;
	declare onseeking: ((this: Video, ev: Event) => any) | null;
	declare onseeked: ((this: Video, ev: Event) => any) | null;
	declare ontimeupdate: ((this: Video, ev: Event) => any) | null;
	declare onended: ((this: Video, ev: Event) => any) | null;
	declare onerror: ((this: Video, ev: ErrorEvent) => any) | null;

	constructor(src?: string) {
		super();
		const v = proto($.videoNew(), Video);
		v.onloadedmetadata = null;
		v.oncanplay = null;
		v.oncanplaythrough = null;
		v.onplay = null;
		v.onpause = null;
		v.onseeking = null;
		v.onseeked = null;
		v.ontimeupdate = null;
		v.onended = null;
		v.onerror = null;
		_.set(v, {
			src: '',
			currentSrc: '',
			loadSeq: 0,
			metadata: null,
			readyState: HAVE_NOTHING,
			paused: true,
			ended: false,
			loop: false,
			volume: 1,
			muted: false,
			seeking: false,
			gain: null,
			streamNode: null,
			tickInterval: null,
			lastTimeupdate: 0,
			canplayFired: false,
			errorFired: false,
			pendingPlays: [],
		});
		const ref = new WeakRef(v);
		addEventListener('unload', () => {
			const video = ref.deref();
			if (!video) return;
			stopTicking(video);
			$.videoClose(handleOf(video));
		});
		if (src) {
			v.src = src;
		}
		return v;
	}

	get src(): string {
		return _(this).src;
	}

	set src(val: string) {
		_(this).src = val;
		this.load();
	}

	get currentSrc(): string {
		return _(this).currentSrc;
	}

	/**
	 * The intrinsic width (in pixels) of the video, or `0` before
	 * `loadedmetadata`.
	 */
	get videoWidth(): number {
		return _(this).metadata?.width ?? 0;
	}

	/**
	 * The intrinsic height (in pixels) of the video, or `0` before
	 * `loadedmetadata`.
	 */
	get videoHeight(): number {
		return _(this).metadata?.height ?? 0;
	}

	get duration(): number {
		const i = _(this);
		if (!i.metadata) return NaN;
		return i.metadata.duration;
	}

	get currentTime(): number {
		if (!_(this).metadata) return 0;
		return $.videoState(handleOf(this))?.currentTime ?? 0;
	}

	set currentTime(val: number) {
		const i = _(this);
		if (!i.metadata) return;
		i.seeking = true;
		i.ended = false;
		$.videoSeek(handleOf(this), val);
		this.dispatchEvent(new Event('seeking'));
		startTicking(this); // pump until the seek converges
	}

	get seeking(): boolean {
		return _(this).seeking;
	}

	/** Audio streams advertised by the opened file (IDs are stream indices). */
	get audioTracks(): VideoMediaTrack[] {
		return _(this).metadata ? $.videoTracks(handleOf(this), false) : [];
	}

	/** Text and bitmap streams; `supported` is false for bitmap subtitles. */
	get subtitleTracks(): VideoMediaTrack[] {
		return _(this).metadata ? $.videoTracks(handleOf(this), true) : [];
	}

	get selectedAudioTrack(): number {
		return _(this).metadata ? $.videoState(handleOf(this)).audioTrack : -1;
	}

	get selectedSubtitleTrack(): number {
		return _(this).metadata ? $.videoState(handleOf(this)).subtitleTrack : -1;
	}

	get trackError(): string {
		return _(this).metadata ? $.videoState(handleOf(this)).trackError ?? '' : '';
	}

	/** Limit presentation buffers to this rectangle; set before src. Intrinsic size is preserved. */
	setRenderSize(maxWidth: number, maxHeight: number): void {
		if (![maxWidth, maxHeight].every(v => Number.isInteger(v) && v > 0 && v <= 4096)) throw new RangeError('Invalid video render bounds.');
		if (_(this).src) throw new DOMException('Set render bounds before src.', 'InvalidStateError');
		$.videoSetRenderSize(handleOf(this), maxWidth, maxHeight);
	}

	/** Presentation dimensions and peak transfer/conversion milliseconds since the last call. */
	getFrameStats(): { width: number; height: number; transferMs: number; convertMs: number } {
		return $.videoFrameStats(handleOf(this));
	}

	/** Active decoding backend. NVDEC is reported after a hardware frame transfers successfully. */
	get decoder(): 'software' | 'nvdec-pending' | 'nvdec' {
		return _(this).metadata ? $.videoState(handleOf(this)).decoder : 'software';
	}

	selectAudioTrack(id: number): void { selectTrack(this, id, false); }

	/** Select an embedded text subtitle stream, or -1 for Off. */
	selectSubtitleTrack(id: number): void { selectTrack(this, id, true); }

	/** Active plain text at a media timestamp. The application renders it. */
	getSubtitleText(seconds = this.currentTime): string {
		return _(this).metadata ? $.videoSubtitleText(handleOf(this), seconds) : '';
	}

	get paused(): boolean {
		return _(this).paused;
	}

	get ended(): boolean {
		return _(this).ended;
	}

	get loop(): boolean {
		return _(this).loop;
	}

	set loop(val: boolean) {
		_(this).loop = val;
		if (_(this).metadata) {
			$.videoSetLoop(handleOf(this), val);
		}
	}

	get volume(): number {
		return _(this).volume;
	}

	set volume(val: number) {
		_(this).volume = Math.max(0, Math.min(1, val));
		applyVolume(this);
	}

	get muted(): boolean {
		return _(this).muted;
	}

	set muted(val: boolean) {
		_(this).muted = val;
		applyVolume(this);
	}

	get readyState(): number {
		return _(this).readyState;
	}

	static get HAVE_NOTHING() {
		return HAVE_NOTHING;
	}
	static get HAVE_METADATA() {
		return HAVE_METADATA;
	}
	static get HAVE_CURRENT_DATA() {
		return HAVE_CURRENT_DATA;
	}
	static get HAVE_FUTURE_DATA() {
		return HAVE_FUTURE_DATA;
	}
	static get HAVE_ENOUGH_DATA() {
		return HAVE_ENOUGH_DATA;
	}

	/**
	 * Returns metrics about the video frames that have been presented and
	 * dropped.
	 *
	 * @see https://developer.mozilla.org/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality
	 */
	getVideoPlaybackQuality(): VideoPlaybackQuality {
		const i = _(this);
		let presented = 0;
		let dropped = 0;
		if (i.metadata) {
			const state = $.videoState(handleOf(this));
			if (state) {
				presented = state.presentedFrames;
				dropped = state.droppedFrames;
			}
		}
		return {
			creationTime: 0,
			totalVideoFrames: presented + dropped,
			droppedVideoFrames: dropped,
			corruptedVideoFrames: 0,
			// @ts-expect-error `toJSON` is part of the legacy interface
			toJSON() {
				return { ...this };
			},
		};
	}

	load(): void {
		const i = _(this);
		// The FIRST load (establishing the initial source) must not abort
		// queued play() promises or reset `paused` — a source-less play()
		// stays pending until a source arrives and then starts playback
		// (Chrome behavior). A SUPERSEDING load (src changed while a load
		// was in flight or a source was already set) aborts pending plays
		// and pauses (Chrome rejects with "The play() request was
		// interrupted by a new load request").
		const firstLoad = i.loadSeq === 0;
		const seq = ++i.loadSeq;

		stopTicking(this);
		if (!firstLoad) {
			settlePendingPlays(
				i,
				new DOMException(
					'The play() request was interrupted by a new load request.',
					'AbortError',
				),
			);
			i.paused = true;
		}
		i.metadata = null;
		i.readyState = HAVE_NOTHING;
		i.ended = false;
		i.seeking = false;
		i.canplayFired = false;
		i.errorFired = false;
		i.streamNode = null;
		i.gain?.disconnect();
		i.gain = null;
		if (!i.src) {
			i.paused = true;
			i.currentSrc = '';
			$.videoReset(handleOf(this));
			return;
		}

		const url = new URL(i.src, $.entrypoint);
		i.currentSrc = url.href;

		// Non-FILE_SCHEMES loads use call-time `globalThis.fetch` so
		// embedder-installed wrappers (e.g. extended URL schemes) are
		// honored — see note in `image.ts`.
		const loadPromise = FILE_SCHEMES.has(url.protocol)
			? $.videoLoad(handleOf(this), decodeURI(url.href), null)
			: STREAM_SCHEMES.has(url.protocol)
				? $.videoLoad(handleOf(this), url.href, null)
				: globalThis.fetch(url)
					.then((res) => {
						if (!res.ok) {
							throw new Error(`Failed to load video: ${res.status}`);
						}
						return res.arrayBuffer();
					})
					.then((buf) => {
						if (i.loadSeq !== seq) throw new DOMException('Load superseded', 'AbortError');
						return $.videoLoad(handleOf(this), null, buf);
					});

		loadPromise.then(
			(metadata) => {
				if (_(this).loadSeq !== seq) return; // superseded by a new src
				i.metadata = metadata;
				$.videoSetLoop(handleOf(this), i.loop);
				if (metadata.hasAudio) {
					const ctx = getSharedAudioContext();
					const stream = $.videoCreateAudioNode(
						handleOf(this),
						ctxInternal(ctx).handle,
					);
					if (stream) {
						i.streamNode = stream;
						if (!i.gain) {
							i.gain = ctx.createGain();
							i.gain.connect(ctx.destination);
						}
						$.audioNodeConnect(stream, nodeInternal(i.gain).handle);
						applyVolume(this);
					}
				}
				i.readyState = HAVE_METADATA;
				this.dispatchEvent(new Event('loadedmetadata'));
				if (!i.paused) {
					// An eager `play()` (called before metadata loaded)
					// queued playback — begin it now.
					$.videoPlay(handleOf(this));
				}
				settlePendingPlays(i);
				// Pre-buffering starts immediately; pump until `canplay`.
				startTicking(this);
			},
			(error) => {
				if (_(this).loadSeq !== seq) return;
				settlePendingPlays(
					i,
					new DOMException(
						'Failed to load because no supported source was found.',
						'NotSupportedError',
					),
				);
				this.dispatchEvent(new ErrorEvent('error', { error }));
			},
		);
	}

	play(): Promise<void> {
		const i = _(this);
		const wasPaused = i.paused;
		i.paused = false;
		if (!i.metadata) {
			// Metadata not loaded yet (or no source set at all) — queue
			// playback instead of rejecting (`HTMLMediaElement.play()`
			// never rejects for "not loaded yet"; with no source the
			// promise stays pending until a source arrives, matching
			// Chrome). The promise settles when playback actually begins
			// (see `load()`'s metadata handler), or rejects on load
			// failure / `pause()` / a superseding load.
			const pending = Promise.withResolvers<void>();
			i.pendingPlays.push(pending);
			if (wasPaused) this.dispatchEvent(new Event('play'));
			return pending.promise;
		}
		if (!wasPaused) {
			// Already playing — no state transition, no `play` event
			// (matches Chrome: the promise still resolves).
			return Promise.resolve();
		}
		if (i.ended) {
			// Replay from the start (browser behavior).
			i.ended = false;
			i.seeking = true;
			$.videoSeek(handleOf(this), 0);
		}
		$.videoPlay(handleOf(this));
		startTicking(this);
		this.dispatchEvent(new Event('play'));
		return Promise.resolve();
	}

	pause(): void {
		const i = _(this);
		if (i.paused) return;
		i.paused = true;
		settlePendingPlays(
			i,
			new DOMException(
				'The play() request was interrupted by a call to pause().',
				'AbortError',
			),
		);
		if (i.metadata) {
			$.videoPause(handleOf(this));
			if (!i.seeking) stopTicking(this);
		}
		this.dispatchEvent(new Event('pause'));
	}

	dispatchEvent(event: Event): boolean {
		const handler = (this as any)[`on${event.type}`];
		if (typeof handler === 'function') {
			handler.call(this, event);
		}
		return super.dispatchEvent(event);
	}
}
def(Video);
