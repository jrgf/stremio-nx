// Host test for nx_media_source (the decoder's in-process byte source in the
// fork). A feeder thread simulates the engine: it polls `wanted` and provides
// bytes around it from a reference buffer. The main thread reads sequentially
// and across seeks, verifying every byte, then checks close/EOF behavior.
#include "media-source.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

static int failures = 0;
#define CHECK(cond, msg)                                                       \
	do {                                                                       \
		if (!(cond)) {                                                         \
			fprintf(stderr, "FAIL line %d: %s\n", __LINE__, msg);             \
			failures++;                                                        \
		}                                                                      \
	} while (0)

int main() {
	const int64_t SIZE = 5 * 1024 * 1024 + 123;
	std::vector<uint8_t> ref((size_t)SIZE);
	uint32_t x = 1;
	for (auto &b : ref) {
		x = x * 1103515245u + 12345u;
		b = (uint8_t)(x >> 24);
	}

	nx_media_source *s = nx_media_source_new(SIZE);
	CHECK(nx_media_source_size(s) == SIZE, "size");

	// Feeder: deliver 64 KiB around wherever the decoder is blocked, with a
	// small delay so reads actually have to wait.
	std::atomic<bool> stop{false};
	std::thread feeder([&] {
		while (!stop.load()) {
			int64_t w = nx_media_source_wanted(s);
			if (w < 0) {
				std::this_thread::sleep_for(std::chrono::milliseconds(2));
				continue;
			}
			int64_t len = std::min<int64_t>(64 * 1024, SIZE - w);
			nx_media_source_provide(s, w, ref.data() + w, (size_t)len);
			std::this_thread::sleep_for(std::chrono::milliseconds(1));
		}
	});

	auto read_all = [&](int64_t offset, int64_t n) -> bool {
		std::vector<uint8_t> buf((size_t)n);
		int64_t got = 0;
		while (got < n) {
			int k = nx_media_source_read(s, offset + got, buf.data() + got,
			                             (int)std::min<int64_t>(n - got, 1 << 20));
			if (k <= 0)
				return false;
			got += k;
		}
		return memcmp(buf.data(), ref.data() + offset, (size_t)n) == 0;
	};

	// Sequential read of the whole resource.
	CHECK(read_all(0, SIZE), "full sequential read");
	uint8_t one;
	CHECK(nx_media_source_read(s, SIZE, &one, 1) == 0, "eof at size");

	// Seeks: jump around like an MP4 probe (moov at end, then back).
	CHECK(read_all(SIZE - 4096, 4096), "tail read");
	CHECK(read_all(0, 65536), "head read after tail");
	CHECK(read_all(SIZE / 2 - 7, 100000), "midpoint read across chunks");

	// Buffered accounting is monotonic and bounded by size.
	int64_t buffered = nx_media_source_buffered(s, 0);
	CHECK(buffered >= 0 && buffered <= SIZE, "buffered in range");

	// discard_before frees early bytes without breaking forward reads.
	nx_media_source_discard_before(s, SIZE - 8192);
	CHECK(read_all(SIZE - 8192, 8192), "read after discard_before");

	stop.store(true);
	feeder.join();

	// After close, a blocked read fails rather than hanging.
	nx_media_source_close(s);
	std::vector<uint8_t> buf(4096);
	CHECK(nx_media_source_read(s, 0, buf.data(), 4096) == -1, "read after close");
	nx_media_source_free(s);

	// Sliding-window cost: the app provides ~1 MiB chunks up to 64 MiB ahead and
	// trims the trailing edge a few KiB at a time every 50 ms. Each trim and each
	// provide must be cheap regardless of how much is buffered, and the trailing
	// chunk that straddles the cut is kept whole (bounded waste, no copy).
	{
		const int64_t WIN = 64 << 20;
		nx_media_source *w = nx_media_source_new(WIN * 2);
		std::vector<uint8_t> chunk(1 << 20, 0xAB);
		auto t0 = std::chrono::steady_clock::now();
		for (int64_t off = 0; off < WIN; off += (int64_t)chunk.size())
			nx_media_source_provide(w, off, chunk.data(), chunk.size());
		for (int i = 1; i <= 200; i++) {
			nx_media_source_discard_before(w, (int64_t)i * 8192);
			nx_media_source_provide(w, WIN + (int64_t)(i - 1) * 8192, chunk.data(), 8192);
		}
		double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
		printf("sliding window: 64 MiB provided + 200 trims/tops in %.0f ms\n", ms);
		CHECK(ms < 100, "sliding window trims and provides stay cheap");
		CHECK(nx_media_source_buffered(w, 200 * 8192) == WIN + 200 * 8192 - 200 * 8192, "window still contiguous after trims");
		CHECK(nx_media_source_buffered(w, 0) == 0, "trimmed head is gone at chunk granularity");
		nx_media_source_free(w);
	}

	if (failures == 0)
	{
		auto *w = nx_media_source_new(1024LL << 20);
		std::vector<uint8_t> chunk(1 << 20, 0xAC);
		for (int i = 0; i < 1000; ++i) {
			int64_t start = (int64_t)(i % 100) * chunk.size();
			nx_media_source_retain(w, start, start + 4 * chunk.size());
			for (int k = 0; k < 4; ++k)
				nx_media_source_provide(w, start + k * chunk.size(), chunk.data(), chunk.size());
			CHECK(nx_media_source_stored(w) == 4 * (int64_t)chunk.size(), "seeks keep a bounded window");
		}
		nx_media_source_close(w);
		CHECK(nx_media_source_stored(w) == 0, "close immediately releases all chunks");
		nx_media_source_provide(w, 0, chunk.data(), chunk.size());
		CHECK(nx_media_source_stored(w) == 0, "late provide cannot revive closed source");
		nx_media_source_free(w);
	}

	if (failures == 0)
		printf("PASS\n");
	return failures ? 1 : 0;
}
