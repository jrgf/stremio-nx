// In-process byte source for the media decoder. See media-source.h.
#include "media-source.h"

#include <algorithm>
#include <condition_variable>
#include <map>
#include <mutex>
#include <string.h>
#include <vector>

namespace {
// Poll granularity for the close flag while a read is blocked.
constexpr int WAIT_STEP_MS = 200;
} // namespace

struct nx_media_source {
	int64_t size = 0;
	std::mutex mtx;
	std::condition_variable cv;
	bool closed = false;
	int64_t wanted = -1;
	int64_t position = 0; // decoder's current read cursor
	// Buffered byte ranges keyed by start offset; values are the bytes. Kept
	// non-overlapping but NOT coalesced: each provide() stays its own chunk so
	// that providing and discarding cost only the bytes involved. Merging into
	// one growing vector meant every trim copied the whole buffered window.
	std::map<int64_t, std::vector<uint8_t>> chunks;

	// Bytes contiguously available from `offset` forward. Caller holds mtx.
	int64_t buffered_locked(int64_t offset) {
		auto it = chunks.upper_bound(offset);
		if (it == chunks.begin())
			return 0;
		--it; // greatest start <= offset
		int64_t start = it->first;
		int64_t end = start + (int64_t)it->second.size();
		if (end <= offset)
			return 0;
		int64_t avail = end - offset;
		// Extend across immediately adjacent chunks.
		int64_t cursor = end;
		for (++it; it != chunks.end() && it->first == cursor; ++it) {
			cursor += (int64_t)it->second.size();
			avail += (int64_t)it->second.size();
		}
		return avail;
	}
};

nx_media_source *nx_media_source_new(int64_t size) {
	nx_media_source *s = new nx_media_source();
	s->size = size;
	return s;
}

int64_t nx_media_source_size(nx_media_source *s) { return s->size; }

void nx_media_source_provide(nx_media_source *s, int64_t offset,
                             const uint8_t *data, size_t len) {
	if (len == 0 || offset < 0 || offset >= s->size)
		return;
	{
		std::lock_guard<std::mutex> lock(s->mtx);
		if (s->closed) return;
		// Trim to the resource bounds.
		if (offset + (int64_t)len > s->size)
			len = (size_t)(s->size - offset);
		// Drop the leading part that is already buffered so we only store new
		// bytes and keep chunks non-overlapping.
		int64_t have = s->buffered_locked(offset);
		if (have >= (int64_t)len)
			return;
		int64_t new_start = offset + have;
		const uint8_t *new_data = data + have;
		size_t new_len = len - (size_t)have;
		// Clip at the next chunk's start so chunks never overlap.
		auto next = s->chunks.lower_bound(new_start);
		if (next != s->chunks.end() && next->first < new_start + (int64_t)new_len)
			new_len = (size_t)(next->first - new_start);
		if (new_len == 0)
			return;
		s->chunks.emplace(new_start,
		                  std::vector<uint8_t>(new_data, new_data + new_len));
	}
	s->cv.notify_all();
}

// Drops whole chunks that end at or before `offset`. A chunk straddling the
// cut is kept intact: trimming it would copy its tail on every call, and the
// waste is bounded by one provide() chunk.
void nx_media_source_discard_before(nx_media_source *s, int64_t offset) {
	std::lock_guard<std::mutex> lock(s->mtx);
	while (!s->chunks.empty()) {
		auto it = s->chunks.begin();
		int64_t end = it->first + (int64_t)it->second.size();
		if (end > offset)
			break;
		s->chunks.erase(it);
	}
}

int64_t nx_media_source_wanted(nx_media_source *s) {
	std::lock_guard<std::mutex> lock(s->mtx);
	return s->wanted;
}

void nx_media_source_retain(nx_media_source *s, int64_t start, int64_t end, int64_t prefix_end) {
	std::lock_guard<std::mutex> lock(s->mtx);
	for (auto it = s->chunks.begin(); it != s->chunks.end();) {
		if (it->first >= prefix_end && (it->first >= end || it->first + (int64_t)it->second.size() <= start))
			it = s->chunks.erase(it);
		else
			++it;
	}
}

int64_t nx_media_source_stored(nx_media_source *s) {
	std::lock_guard<std::mutex> lock(s->mtx);
	int64_t bytes = 0;
	for (const auto &chunk : s->chunks) bytes += chunk.second.size();
	return bytes;
}

int64_t nx_media_source_position(nx_media_source *s) {
	std::lock_guard<std::mutex> lock(s->mtx);
	return s->position;
}

int64_t nx_media_source_buffered(nx_media_source *s, int64_t offset) {
	std::lock_guard<std::mutex> lock(s->mtx);
	return s->buffered_locked(offset);
}

int nx_media_source_read(nx_media_source *s, int64_t offset, uint8_t *buf,
                         int n) {
	if (n <= 0)
		return 0;
	if (offset >= s->size)
		return 0;
	std::unique_lock<std::mutex> lock(s->mtx);
	s->position = offset;
	for (;;) {
		if (s->closed)
			return -1;
		int64_t avail = s->buffered_locked(offset);
		if (avail > 0) {
			s->wanted = -1;
			int want = (int)std::min<int64_t>(n, std::min(avail, s->size - offset));
			// Copy from the (possibly multiple) chunks covering [offset, offset+want).
			int copied = 0;
			int64_t pos = offset;
			auto it = s->chunks.upper_bound(pos);
			--it;
			while (copied < want) {
				int64_t cstart = it->first;
				int64_t coff = pos - cstart;
				int64_t cavail = (int64_t)it->second.size() - coff;
				int take = (int)std::min<int64_t>(cavail, want - copied);
				memcpy(buf + copied, it->second.data() + coff, take);
				copied += take;
				pos += take;
				++it;
			}
			return copied;
		}
		// Nothing here yet: publish what we need and wait for a provide/close.
		s->wanted = offset;
		s->cv.notify_all(); // wake any wanted-poller waiting on the same cv
		s->cv.wait_for(lock, std::chrono::milliseconds(WAIT_STEP_MS));
	}
}

void nx_media_source_close(nx_media_source *s) {
	{
		std::lock_guard<std::mutex> lock(s->mtx);
		s->closed = true;
		s->chunks.clear();
	}
	s->cv.notify_all();
}

void nx_media_source_free(nx_media_source *s) { delete s; }
