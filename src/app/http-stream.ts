import type { Stream } from '../stremio/client';
import { httpUrl } from '../stremio/streams';

export const HTTP_CHUNK = 8 * 1024 * 1024; // Range size amortizes connection/redirect costs.
export const HTTP_FEED_CHUNK = 256 * 1024; // Bound each copy into the native playback cache.
/**
 * Max concurrent range requests. The runtime opens a fresh socket per fetch
 * (`connection: close`), so one lane is bounded by a single TCP window per
 * round trip; a starving player adds lanes (see player.ts).
 */
export const HTTP_LANES = 3;
class RetryableReadError extends Error {}

/** Bounded, concurrent range requests; media never goes through Video's full-file fetch. */
export class HttpStream {
	length = 0;
	receivedBytes = 0;
	requests = 0;
	retries = 0;
	/** HTTP 429 responses so far; the player drops to one lane when this grows. */
	throttled = 0;
	path: string[];
	#url: URL;
	#headers = new Headers();
	#requests = new Set<AbortController>();
	#closed = false;
	#validator?: string;
	#resolved?: { url: URL; headers: Headers };

	constructor(stream: Stream) {
		this.#url = httpUrl(stream.url ?? '');
		let name = this.#url.pathname.split('/').at(-1) || 'video';
		try { name = decodeURIComponent(name); } catch { /* Keep an undecodable filename. */ }
		this.path = [stream.behaviorHints?.filename || name];
		const headers = stream.behaviorHints?.proxyHeaders?.request ?? {};
		if (Object.keys(headers).length > 32) throw new Error('Too many stream request headers.');
		for (const [key, value] of Object.entries(headers)) {
			if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || key.length > 128 || typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) {
				throw new Error('Invalid stream request header.');
			}
			if (/^(host|connection|content-length|transfer-encoding|range|if-range|accept-encoding|proxy-authorization)$/i.test(key)) continue;
			this.#headers.set(key, value);
		}
	}

	async open(): Promise<void> { await this.read(0, 1, () => {}); }
	/** Cancels every pending range; stop also prevents future reads. */
	cancel(): void { for (const request of this.#requests) request.abort(); }
	close(): void { this.#closed = true; this.cancel(); }

	/**
	 * Feed a range progressively; only one small delivery block is accumulated.
	 * `signal` cancels just this range (a lane the player no longer needs).
	 */
	async read(start: number, count: number, provide: (offset: number, bytes: Uint8Array) => void, signal?: AbortSignal): Promise<void> {
		if (this.#closed || signal?.aborted) throw new DOMException('Stream stopped.', 'AbortError');
		if (this.#requests.size >= HTTP_LANES) throw new Error('Too many concurrent stream reads.');
		if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid stream range.');
		if (this.length && start >= this.length) return;
		count = Math.min(count, HTTP_CHUNK, this.length ? this.length - start : HTTP_CHUNK);
		const end = start + count - 1;
		if (!Number.isSafeInteger(end)) throw new Error('Invalid stream range.');
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener('abort', abort, { once: true });
		this.#requests.add(controller);
		let next = start;
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					await this.#readRange(next, end, (offset, bytes) => {
						provide(offset, bytes);
						next = offset + bytes.length;
					}, controller.signal);
					return;
				} catch (error) {
					if (controller.signal.aborted) throw new DOMException('Stream cancelled.', 'AbortError');
					if (!(error instanceof RetryableReadError)) throw error;
					// Already delivered complete blocks need not be downloaded again.
					if (next > end) return;
					if (attempt >= 3) throw error;
					this.retries++;
					await new Promise<void>((resolve, reject) => {
						const abort = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); reject(new DOMException('Stream cancelled.', 'AbortError')); };
						const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 250 * 2 ** attempt);
						controller.signal.addEventListener('abort', abort, { once: true });
						if (controller.signal.aborted) abort();
					});
				}
			}
		} finally {
			controller.abort();
			this.#requests.delete(controller);
			signal?.removeEventListener('abort', abort);
		}
	}

	async #readRange(start: number, end: number, provide: (offset: number, bytes: Uint8Array) => void, signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw new DOMException('Stream cancelled.', 'AbortError');
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener('abort', abort, { once: true });
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const activity = (timeout = 10000) => {
			clearTimeout(timer);
			timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
		};
		activity(20000);
		let response: Response | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const resolved = this.#resolved;
			let url = resolved?.url ?? this.#url;
			const headers = new Headers(resolved?.headers ?? this.#headers);
			headers.set('Range', `bytes=${start}-${end}`);
			headers.set('Accept-Encoding', 'identity');
			if (this.#validator) headers.set('If-Range', this.#validator);
			for (let redirects = 0; ; redirects++) {
				this.requests++;
				try { response = await fetch(url.href, { headers, signal: controller.signal, redirect: 'manual' }); }
				catch { throw new RetryableReadError('Could not read the video server. Try another source or check the connection.'); }
				activity(20000);
				if (![301, 302, 303, 307, 308].includes(response.status)) break;
				await response.body?.cancel();
				const location = response.headers.get('location');
				if (!location || redirects >= 8) throw new Error('The video server returned an invalid redirect chain.');
				let next: URL;
				try { next = httpUrl(new URL(location, url).href); } catch { throw new Error('The video server redirected to an unsupported URL.'); }
				if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('The video server redirected HTTPS to an insecure connection.');
				if (url.origin !== next.origin) { headers.delete('authorization'); headers.delete('cookie'); }
				url = next;
			}
			if (resolved && [401, 403, 404, 410].includes(response.status)) {
				this.#resolved = undefined;
				throw new RetryableReadError('The cached video link expired. Refreshing the source.');
			}
			if (response.status === 401 || response.status === 403) throw new Error('Video access was denied. Check the debrid account or refresh the stream list.');
			if (response.status === 429) this.throttled++;
			if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw new RetryableReadError(`Video server temporarily unavailable (HTTP ${response.status}).`);
			const type = response.headers.get('content-type') ?? '';
			if (/mpegurl|dash\+xml/i.test(type)) throw new Error('HLS/DASH playlists are not supported yet. Choose a direct video file.');
			if (/text\/html|application\/json/i.test(type)) throw new Error('The source returned a webpage or account message instead of video.');
			if (response.status === 200) throw new Error('This video server does not support byte-range streaming. Choose another source.');
			if (response.status !== 206) throw new Error(`Video server returned HTTP ${response.status}. Refresh the stream list or choose another source.`);
			const encoding = response.headers.get('content-encoding');
			if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('The video server compressed a byte-range response.');
			const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '');
			const first = Number(range?.[1]), last = Number(range?.[2]), total = Number(range?.[3]);
			if (!range || ![first, last, total].every(Number.isSafeInteger) || first !== start || total <= start || last !== Math.min(end, total - 1) || (this.length && total !== this.length)) {
				throw new Error('The video server returned an invalid or changed byte range.');
			}
			const etag = response.headers.get('etag');
			const validator = etag && !etag.startsWith('W/') ? etag : response.headers.get('last-modified') ?? undefined;
			if (this.#validator && validator && validator !== this.#validator) throw new Error('The video file changed. Refresh the stream list.');
			const size = last - first + 1;
			const declared = response.headers.get('content-length');
			if (declared !== null && Number(declared) !== size) throw new Error('The video server returned an invalid response length.');
			if (!response.body) throw new Error('The video server returned an empty response.');
			// Pin identity before delivery so a resumed range cannot mix different files.
			this.length = total;
			this.#validator ??= validator;
			this.#resolved = url.href === this.#url.href ? undefined : { url, headers: new Headers(headers) };
			activity();
			reader = response.body.getReader();
			let batch = new Uint8Array(Math.min(HTTP_FEED_CHUNK, size));
			let used = 0;
			let offset = 0;
			for (;;) {
				let item: ReadableStreamReadResult<Uint8Array>;
				try { item = await reader.read(); }
				catch { throw new RetryableReadError('The video connection was interrupted.'); }
				const { value, done } = item;
				if (controller.signal.aborted) throw new DOMException('Stream cancelled.', 'AbortError');
				if (done) break;
				if (value.length > size - offset) throw new Error('The video server exceeded the requested range.');
				activity();
				this.receivedBytes += value.length;
				for (let pos = 0; pos < value.length;) {
					if (controller.signal.aborted) throw new DOMException('Stream cancelled.', 'AbortError');
					const take = Math.min(batch.length - used, value.length - pos);
					batch.set(value.subarray(pos, pos + take), used);
					pos += take;
					used += take;
					offset += take;
					if (used === batch.length) {
						provide(start + offset - used, batch);
						used = 0;
						if (offset < size) batch = new Uint8Array(Math.min(HTTP_FEED_CHUNK, size - offset));
					}
				}
			}
			if (offset !== size) throw new RetryableReadError('The video connection ended before the requested range arrived.');
		} catch (error) {
			if (signal.aborted) throw new DOMException('Video request cancelled.', 'AbortError');
			if (timedOut) throw new RetryableReadError('The video server timed out. Try again or choose another source.');
			throw error;
		} finally {
			clearTimeout(timer);
			if (reader) await reader.cancel().catch(() => {});
			else await response?.body?.cancel().catch(() => {});
			controller.abort();
			signal.removeEventListener('abort', abort);
		}
	}
}
