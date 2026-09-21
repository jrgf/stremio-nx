#pragma once
// Portable blocking HTTP/1.1 range reader (plain `http://`, no TLS).
//
// Backs streaming media playback from network sources: the decoder thread
// reads sequentially from one connection and seeks by re-requesting the
// resource from a new offset (`Range: bytes=<pos>-`). No libnx, no V8 —
// compiled into both the device runtime and the host nxjs-test binary.
//
// Single-threaded: all calls on one reader must come from the same thread.
// Blocking calls poll the optional `abort` flag every few hundred ms and give
// up (returning an error) once it is set, so a decode thread can be stopped
// while a read is in flight.
#include <atomic>
#include <stddef.h>
#include <stdint.h>

struct nx_http_reader;

// Parses `url` (http://host[:port]/path) and issues the first request to learn
// the resource size. Blocking. Returns NULL and fills `errbuf` on failure.
nx_http_reader *nx_http_reader_open(const char *url, std::atomic<bool> *abort,
                                    char *errbuf, size_t errbuf_size);

// Total resource size in bytes (known after a successful open).
int64_t nx_http_reader_size(nx_http_reader *r);

// Current read position.
int64_t nx_http_reader_pos(nx_http_reader *r);

// Reads up to `n` bytes at the current position. Returns the number of bytes
// read (> 0), 0 at the end of the resource, or -1 on error / abort.
int nx_http_reader_read(nx_http_reader *r, uint8_t *buf, int n);

// Repositions the reader; the next read continues from `pos`. Small forward
// skips are read through on the open connection, anything else reconnects.
// Returns false if `pos` is outside [0, size].
bool nx_http_reader_seek(nx_http_reader *r, int64_t pos);

// Last error message (valid after a failed call).
const char *nx_http_reader_error(nx_http_reader *r);

void nx_http_reader_close(nx_http_reader *r);
