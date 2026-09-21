#pragma once
// In-process byte source for the media decoder: an embedder (JS) pushes bytes
// in, the decode thread reads them out, blocking until the requested range is
// available. Lets an app stream media it produces itself (a torrent engine, a
// custom downloader) straight into `Video` without a loopback socket.
//
// Threading: `provide`/`discard_before`/`wanted`/`close` are called from the
// embedder (the JS main thread); `read` is called from the decoder thread and
// blocks. All are internally synchronized. No V8, no libnx — compiled into
// both the device runtime and the host test binary.
#include <memory>
#include <stddef.h>
#include <stdint.h>

typedef struct nx_media_source nx_media_source;

// Create a source for a resource of `size` bytes.
nx_media_source *nx_media_source_new(int64_t size);

int64_t nx_media_source_size(nx_media_source *s);

// Deliver `len` bytes starting at `offset`. Copies the data. Safe to call with
// overlapping or out-of-order ranges; bytes past the read window may be
// dropped once `cap` is exceeded (the embedder should feed near `wanted`).
void nx_media_source_provide(nx_media_source *s, int64_t offset,
                             const uint8_t *data, size_t len);

// Drop buffered bytes below `offset` to bound memory. The decoder never reads
// backwards past its current position without a seek, which resets the window.
void nx_media_source_discard_before(nx_media_source *s, int64_t offset);
// Optionally also retain an opening prefix for metadata probes and restart seeks.
void nx_media_source_retain(nx_media_source *s, int64_t start, int64_t end, int64_t prefix_end = 0);
int64_t nx_media_source_stored(nx_media_source *s);

// The offset the decoder is currently blocked on (or last read from). The
// embedder polls this to decide what to fetch next. -1 if nothing pending.
int64_t nx_media_source_wanted(nx_media_source *s);

// The decoder's current read cursor (offset of its most recent read). Unlike
// `wanted`, this is valid during smooth playback (when the decoder is not
// blocked), so the embedder can slide its buffer window to follow playback.
int64_t nx_media_source_position(nx_media_source *s);

// Bytes buffered and immediately readable from `offset` forward.
int64_t nx_media_source_buffered(nx_media_source *s, int64_t offset);

// DECODER THREAD: read up to `n` bytes at `offset`, blocking until at least one
// byte is available there. Returns bytes read (>0), 0 at end of resource, or
// -1 if the source was closed while waiting.
int nx_media_source_read(nx_media_source *s, int64_t offset, uint8_t *buf,
                         int n);

// Wake any blocked read and make all further reads fail. Idempotent.
void nx_media_source_close(nx_media_source *s);

void nx_media_source_free(nx_media_source *s);
