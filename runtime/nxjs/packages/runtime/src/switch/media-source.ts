import { $ } from '../$';

/**
 * An in-process byte source for the {@link Video} element. The application
 * pushes bytes in with {@link MediaSource.provide | `provide()`}; the decoder
 * reads them out, blocking until the range it needs is available. Assign
 * {@link MediaSource.url | `url`} to `Video.src`.
 *
 * Unlike a file or `http://` source, the bytes come from the app itself (a
 * torrent engine, a custom downloader), with no loopback socket. Poll
 * {@link MediaSource.wanted | `wanted`} to learn which offset the decoder is
 * blocked on and fetch around it; call {@link MediaSource.discardBefore |
 * `discardBefore()`} to bound memory.
 *
 * @example
 * ```ts
 * const source = new Switch.MediaSource(totalBytes);
 * const video = new Switch.Video(source.url);
 * // feed loop:
 * const want = source.wanted;
 * if (want >= 0) source.provide(want, await engine.read(want, 1 << 20));
 * ```
 */
export class MediaSource {
	#id: number;
	#closed = false;

	/** @param size Total size of the resource in bytes. */
	constructor(size: number) {
		this.#id = $.mediaSourceNew(size);
	}

	/** The `nxms:` URL to assign to a {@link Video}'s `src`. */
	get url(): string {
		return `nxms:${this.#id}`;
	}

	/**
	 * The byte offset the decoder is currently blocked on (or last read from),
	 * or `-1` if it is not waiting. Poll this to prioritize what to fetch.
	 */
	get wanted(): number {
		return $.mediaSourceWanted(this.#id);
	}

	/** The decoder's current read cursor (valid during smooth playback), for
	 * sliding a buffer window to follow playback. */
	get position(): number {
		return $.mediaSourcePosition(this.#id);
	}

	/** Bytes contiguously available from `offset` forward. */
	buffered(offset: number): number {
		return $.mediaSourceBuffered(this.#id, offset);
	}

	/** Deliver `data` at `offset`. Bytes already present are ignored. */
	provide(offset: number, data: BufferSource): void {
		$.mediaSourceProvide(this.#id, offset, data);
	}

	/** Drop buffered bytes below `offset` to bound memory use. Works at the
	 * granularity of the chunks passed to `provide()`: a chunk straddling
	 * `offset` is kept whole. */
	discardBefore(offset: number): void {
		$.mediaSourceDiscardBefore(this.#id, offset);
	}

	/** Keep [start, end) plus an optional opening prefix; boundary chunks stay whole. */
	retain(start: number, end: number, prefixEnd = 0): void {
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(prefixEnd) || start < 0 || end < start || prefixEnd < 0) throw new RangeError('Invalid media window');
		$.mediaSourceRetain(this.#id, start, end, prefixEnd);
	}

	/** Total retained bytes, including disjoint ranges. */
	get storedBytes(): number { return $.mediaSourceStored(this.#id); }

	/**
	 * Wake any blocked decoder and release this source. Call after the backing
	 * {@link Video} is closed (or on failure) so its memory is freed.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		$.mediaSourceClose(this.#id);
	}
}
