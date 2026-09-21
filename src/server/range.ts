/**
 * HTTP range responses for a byte-addressable resource. The media player
 * (FFmpeg's HTTP client) seeks with `Range: bytes=start-` requests.
 */
import type { HttpRequest, HttpResponse } from './http';

export interface ByteRange {
	start: number;
	/** Exclusive. */
	end: number;
}

export type RangeReader = (range: ByteRange) => AsyncIterable<Uint8Array>;

/** Parses a single-range `Range` header. `null` if absent, `'invalid'` if unsatisfiable. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return 'invalid';
	const [, first, last] = match;
	if (first === '' && last === '') return 'invalid';
	if (first === '') {
		const suffix = Math.min(Number(last), size);
		return suffix === 0 ? 'invalid' : { start: size - suffix, end: size };
	}
	const start = Number(first);
	const end = last === '' ? size : Math.min(Number(last) + 1, size);
	if (start >= size || start >= end) return 'invalid';
	return { start, end };
}

export function rangeResponse(req: HttpRequest, size: number, contentType: string, read: RangeReader): HttpResponse {
	const range = parseRange(req.headers.get('range'), size);
	const baseHeaders = { 'Accept-Ranges': 'bytes', 'Content-Type': contentType };
	if (range === 'invalid') {
		return { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } };
	}
	if (range === null) {
		return { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) }, body: read({ start: 0, end: size }) };
	}
	return {
		status: 206,
		headers: {
			...baseHeaders,
			'Content-Length': String(range.end - range.start),
			'Content-Range': `bytes ${range.start}-${range.end - 1}/${size}`,
		},
		body: read(range),
	};
}

/** Splits a range into fixed-size chunks read on demand. */
export function chunked(chunkSize: number, readChunk: (start: number, end: number) => Promise<Uint8Array>): RangeReader {
	return async function* ({ start, end }) {
		for (let offset = start; offset < end; offset += chunkSize) {
			yield await readChunk(offset, Math.min(offset + chunkSize, end));
		}
	};
}
