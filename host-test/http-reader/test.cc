// Host test for nx.js's HTTP range reader (source/http-reader.cc in the fork),
// run against the Node range server in ../range-server.ts.
//   test <url> <file>
#include "http-reader.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <vector>

static std::vector<uint8_t> load(const char *path) {
	std::ifstream in(path, std::ios::binary);
	return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)),
	                            std::istreambuf_iterator<char>());
}

#define CHECK(cond, msg)                                                       \
	do {                                                                       \
		if (!(cond)) {                                                         \
			fprintf(stderr, "FAIL line %d: %s (%s)\n", __LINE__, msg,          \
			        nx_http_reader_error(r));                                  \
			return 1;                                                          \
		}                                                                      \
	} while (0)

// Reads exactly `n` bytes from `pos` and compares with the file.
static bool read_matches(nx_http_reader *r, const std::vector<uint8_t> &file,
                         int64_t pos, size_t n) {
	std::vector<uint8_t> buf(n);
	size_t got = 0;
	while (got < n) {
		int k = nx_http_reader_read(r, buf.data() + got, (int)(n - got));
		if (k <= 0)
			return false;
		got += (size_t)k;
	}
	return memcmp(buf.data(), file.data() + pos, n) == 0 &&
	       nx_http_reader_pos(r) == pos + (int64_t)n;
}

int main(int argc, char **argv) {
	if (argc != 3) {
		fprintf(stderr, "usage: test <url> <file>\n");
		return 2;
	}
	std::vector<uint8_t> file = load(argv[2]);
	int64_t size = (int64_t)file.size();
	std::atomic<bool> abort{false};
	char err[256] = {};
	nx_http_reader *r = nx_http_reader_open(argv[1], &abort, err, sizeof(err));
	if (!r) {
		fprintf(stderr, "FAIL open: %s\n", err);
		return 1;
	}
	CHECK(nx_http_reader_size(r) == size, "size");

	// Sequential read of the whole resource in odd-sized chunks, then EOF.
	CHECK(read_matches(r, file, 0, (size_t)size), "full sequential read");
	uint8_t byte;
	CHECK(nx_http_reader_read(r, &byte, 1) == 0, "eof after full read");

	// Backward seek (reconnect), read across a chunk boundary of the server.
	CHECK(nx_http_reader_seek(r, size / 2 - 7), "seek to middle");
	CHECK(read_matches(r, file, size / 2 - 7, 1000), "read after middle seek");

	// Small forward skip: read through on the open connection.
	int64_t skip_to = nx_http_reader_pos(r) + 12345;
	CHECK(nx_http_reader_seek(r, skip_to), "small forward seek");
	CHECK(read_matches(r, file, skip_to, 500), "read after forward skip");

	// Large forward seek (reconnect) near the end, then EOF.
	CHECK(nx_http_reader_seek(r, size - 5), "seek near end");
	CHECK(read_matches(r, file, size - 5, 5), "tail read");
	CHECK(nx_http_reader_read(r, &byte, 1) == 0, "eof at end");

	// Seeking to exactly `size` is allowed (EOF), beyond it is not.
	CHECK(nx_http_reader_seek(r, size), "seek to size");
	CHECK(nx_http_reader_read(r, &byte, 1) == 0, "eof at size");
	CHECK(!nx_http_reader_seek(r, size + 1), "seek past end rejected");
	CHECK(!nx_http_reader_seek(r, -1), "negative seek rejected");

	// Abort flag: a read that needs a new connection fails fast.
	CHECK(nx_http_reader_seek(r, 0), "seek to start");
	abort.store(true);
	int k = nx_http_reader_read(r, &byte, 1);
	CHECK(k <= 0 || nx_http_reader_read(r, &byte, 1) <= 0, "abort stops reads");
	nx_http_reader_close(r);

	// Bad URL and unreachable server.
	std::atomic<bool> no_abort{false};
	CHECK(nx_http_reader_open("ftp://x/", &no_abort, err, sizeof(err)) == nullptr, "bad scheme");
	CHECK(nx_http_reader_open("http://127.0.0.1:1/x", &no_abort, err, sizeof(err)) == nullptr, "refused");
	printf("PASS (%lld bytes)\n", (long long)size);
	return 0;
}
