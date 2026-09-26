import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { HttpStream, HTTP_CHUNK, HTTP_FEED_CHUNK, HTTP_LANES } from '../src/app/http-stream';
import { httpUrl, streamKind } from '../src/stremio/streams';

async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 400 && !cond(); i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.ok(cond(), 'condition not reached');
}

async function readRange(input: HttpStream, start: number, count: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let next = start;
	await input.read(start, count, (offset, bytes) => {
		assert.equal(offset, next);
		assert.ok(bytes.length <= HTTP_FEED_CHUNK);
		next += bytes.length;
		chunks.push(bytes);
	});
	return Buffer.concat(chunks);
}

test('HTTP video ranges are bounded, seekable, cancellable and validate server responses', async () => {
	const total = 20 * 1024 * 1024;
	const requests: { start: number; end: number }[] = [];
	let stopped = false;
	let redirects = 0;
	const server = createServer((req, res) => {
		if (req.url === '/redirect') { redirects++; res.writeHead(302, { Location: '/video' }); res.end(); return; }
		if (req.url === '/ignore') { res.writeHead(200, { 'Content-Length': total }); res.write('x'); req.on('close', () => { stopped = true; }); return; }
		if (req.url === '/slow') { req.on('close', () => { stopped = true; }); return; }
		if (req.url === '/denied') { res.writeHead(403); res.end(); return; }
		const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
		assert.ok(match);
		const start = Number(match[1]), end = Math.min(Number(match[2]), total - 1);
		requests.push({ start, end });
		assert.ok(String(req.headers['accept-encoding']).split(',').every(value => value.trim() === 'identity'));
		assert.equal(req.headers['x-media'], 'test');
		const bytes = Buffer.alloc(end - start + 1);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
		res.writeHead(206, { 'Content-Range': `bytes ${req.url === '/wrong' ? start + 1 : start}-${end}/${total}`, 'Content-Type': 'video/mp4', ETag: '"same"' });
		res.end(req.url === '/short' ? bytes.subarray(0, -1) : bytes);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address(); assert.ok(address && typeof address !== 'string');
	const base = `http://127.0.0.1:${address.port}`;
	const make = (path: string) => new HttpStream({ url: base + path, behaviorHints: { proxyHeaders: { request: { 'X-Media': 'test' } }, filename: 'movie.mkv' } });
	try {
		const input = make('/redirect');
		await input.open(); assert.equal(input.length, total); assert.deepEqual(input.path, ['movie.mkv']);
		for (const offset of [0, 9 * 1024 * 1024 + 7, 100, total - 57]) {
			const bytes = await readRange(input, offset, 100 * HTTP_CHUNK);
			assert.equal(bytes.length, Math.min(HTTP_CHUNK, total - offset));
			for (let i = 0; i < bytes.length; i += 997) assert.equal(bytes[i], (offset + i) % 251);
		}
		assert.ok(requests.every(r => r.end - r.start + 1 <= HTTP_CHUNK));
		assert.equal(redirects, 1, 'the resolved CDN URL is reused for later ranges');
		assert.equal((await readRange(input, total, 10)).length, 0);
		input.close(); await assert.rejects(readRange(input, 0, 10), { name: 'AbortError' });
		await assert.rejects(make('/wrong').open(), /invalid or changed byte range/);
		await assert.rejects(make('/short').open(), /connection ended/);
		await assert.rejects(make('/denied').open(), /access was denied/);
		await assert.rejects(make('/ignore').open(), /byte-range/);
		const slow = make('/slow'), pending = slow.open();
		setTimeout(() => slow.close(), 30);
		await assert.rejects(pending, { name: 'AbortError' });
		await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, true);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTTP prefetch delivers bounded blocks before the full range arrives and cancels mid-body', async () => {
	const original = globalThis.fetch;
	let arrived = 0, delivered = 0, feeds = 0;
	globalThis.fetch = async () => new Response(new ReadableStream({
		pull(controller) {
			if (arrived === HTTP_CHUNK) { controller.close(); return; }
			const block = new Uint8Array(16384).fill(arrived / 16384 % 251);
			arrived += block.length;
			controller.enqueue(block);
		},
	}), { status: 206, headers: { 'Content-Range': `bytes 0-${HTTP_CHUNK - 1}/${HTTP_CHUNK}` } });
	try {
		const input = new HttpStream({ url: 'https://video.example/movie' });
		await input.read(0, HTTP_CHUNK, (offset, bytes) => {
			if (!feeds) assert.ok(arrived < HTTP_CHUNK, 'first data reaches the player before the request finishes');
			assert.equal(offset, delivered); assert.equal(bytes.length, HTTP_FEED_CHUNK);
			for (let i = 0; i < bytes.length; i += 16384) assert.equal(bytes[i], (offset + i) / 16384 % 251);
			delivered += bytes.length; feeds++;
		});
		assert.equal(delivered, HTTP_CHUNK); assert.equal(feeds, HTTP_CHUNK / HTTP_FEED_CHUNK);
		assert.equal(input.receivedBytes, HTTP_CHUNK); assert.equal(input.requests, 1);
		arrived = 0; feeds = 0;
		await assert.rejects(input.read(0, HTTP_CHUNK, () => { feeds++; input.cancel(); }), { name: 'AbortError' });
		assert.equal(feeds, 1, 'cancellation must stop delivery even with queued response bytes');
		assert.ok(arrived < HTTP_CHUNK);
	} finally { globalThis.fetch = original; }
});

test('URL hints survive redirects without leaking credentials or accepting unsafe sources', async () => {
	assert.equal(streamKind({ url: 'https://cdn.example/movie.mkv' }), 'url');
	assert.equal(streamKind({ externalUrl: 'https://provider.example/watch' }), 'external');
	for (const value of ['file:///secret', 'javascript:alert(1)', 'https://user:pass@example.com', 'bad']) {
		assert.throws(() => httpUrl(value)); assert.equal(streamKind({ url: value }), 'unsupported');
	}
	assert.throws(() => new HttpStream({ url: 'https://video.example', behaviorHints: { proxyHeaders: { request: { Referer: 'a\r\nx: bad' } } } }), /Invalid/);
	const original = globalThis.fetch;
	let mode = 'redirect', calls = 0;
	globalThis.fetch = async (url, init) => {
		calls++;
		assert.equal(init?.redirect, 'manual');
		const headers = new Headers(init?.headers);
		assert.equal(headers.get('range'), 'bytes=0-0');
		if (mode === 'downgrade') return new Response(null, { status: 302, headers: { Location: 'http://cdn.example/movie' } });
		if (mode === 'big') return new Response(new Uint8Array(10), { status: 206, headers: { 'Content-Range': 'bytes 0-0/100' } });
		if (String(url).includes('video.example')) {
			assert.equal(headers.get('authorization'), 'Bearer secret');
			return new Response(null, { status: 302, headers: { Location: 'https://cdn.example/movie' } });
		}
		assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null);
		assert.equal(headers.get('user-agent'), 'test-player');
		return new Response(new Uint8Array([1]), { status: 206, headers: { 'Content-Range': 'bytes 0-0/100' } });
	};
	const make = () => new HttpStream({ url: 'https://video.example/start?private=token', behaviorHints: { proxyHeaders: { request: { Authorization: 'Bearer secret', Cookie: 'session=secret', 'User-Agent': 'test-player' } } } });
	try {
		await make().open(); assert.equal(calls, 2);
		mode = 'downgrade'; await assert.rejects(make().open(), /insecure/);
		mode = 'big'; await assert.rejects(make().open(), /exceeded/);
	} finally { globalThis.fetch = original; }
});

test('HTTP resumes interrupted ranges at the last delivered block and pins file identity', async () => {
	const original = globalThis.fetch;
	const size = HTTP_FEED_CHUNK * 3 + 17;
	let calls = 0, changed = false;
	const body = (start: number, end: number) => Uint8Array.from({ length: end - start + 1 }, (_, i) => (start + i) % 251);
	globalThis.fetch = async (_url, init) => {
		const headers = new Headers(init?.headers);
		const [start, end] = headers.get('range')!.slice(6).split('-').map(Number);
		calls++;
		assert.equal(start, calls === 1 ? 0 : HTTP_FEED_CHUNK);
		if (calls > 1) assert.equal(headers.get('if-range'), '"v1"');
		return new Response(body(start, calls === 1 ? HTTP_FEED_CHUNK + 100 : end), { status: 206, headers: {
			'Content-Range': `bytes ${start}-${end}/${size}`, ETag: changed && calls > 1 ? '"v2"' : '"v1"',
		} });
	};
	try {
		const input = new HttpStream({ url: 'https://video.example/movie' });
		assert.deepEqual(await readRange(input, 0, size), Buffer.from(body(0, size - 1)));
		assert.equal(calls, 2); assert.equal(input.retries, 1);
		calls = 0; changed = true;
		await assert.rejects(readRange(new HttpStream({ url: 'https://video.example/movie' }), 0, size), /file changed/);
		assert.equal(calls, 2, 'identity errors must not be retried');
	} finally { globalThis.fetch = original; }
});

test('HTTP refreshes an expired CDN URL without forwarding origin credentials', async () => {
	const original = globalThis.fetch;
	let expired = false, originCalls = 0, cdnCalls = 0;
	globalThis.fetch = async (url, init) => {
		const headers = new Headers(init?.headers);
		if (String(url).includes('origin.example')) {
			originCalls++;
			assert.equal(headers.get('authorization'), 'Bearer private');
			return new Response(null, { status: 302, headers: { Location: `https://cdn.example/${expired ? 'new' : 'old'}` } });
		}
		cdnCalls++;
		assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null);
		if (expired && String(url).endsWith('/old')) return new Response(null, { status: 403 });
		return new Response(new Uint8Array([1]), { status: 206, headers: { 'Content-Range': 'bytes 0-0/100', ETag: '"same"' } });
	};
	try {
		const input = new HttpStream({ url: 'https://origin.example/movie', behaviorHints: { proxyHeaders: { request: { Authorization: 'Bearer private', Cookie: 'private=yes' } } } });
		await input.open(); await readRange(input, 0, 1);
		assert.equal(originCalls, 1); assert.equal(cdnCalls, 2);
		expired = true; await readRange(input, 0, 1);
		assert.equal(originCalls, 2); assert.equal(cdnCalls, 4); assert.equal(input.retries, 1);
	} finally { globalThis.fetch = original; }
});

test('HTTP retry backoff is cancellable and transient retries have a finite budget', async () => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => { calls++; return new Response(null, { status: 503 }); };
	try {
		const input = new HttpStream({ url: 'https://video.example/movie' });
		const pending = input.open();
		setTimeout(() => input.close(), 20);
		await assert.rejects(pending, { name: 'AbortError' });
		assert.equal(calls, 1);
		calls = 0;
		await assert.rejects(new HttpStream({ url: 'https://video.example/movie' }).open(), /HTTP 503/);
		assert.equal(calls, 4);
	} finally { globalThis.fetch = original; }
});

test('HTTP lanes run bounded concurrent ranges, cancel one by signal and all by cancel()', async () => {
	const original = globalThis.fetch;
	const size = 4 * HTTP_FEED_CHUNK;
	let active = 0, peak = 0, deny = 0;
	const releases: (() => void)[] = [];
	globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
		const [start, end] = new Headers(init?.headers).get('range')!.slice(6).split('-').map(Number);
		if (deny > 0) { deny--; resolve(new Response(null, { status: 429 })); return; }
		active++; peak = Math.max(peak, active);
		// The stream aborts its controller after every range, so settle only once.
		let done = false;
		const settle = () => !done && (done = true) && --active >= 0;
		init?.signal?.addEventListener('abort', () => { if (settle()) reject(new DOMException('aborted', 'AbortError')); }, { once: true });
		releases.push(() => { if (settle()) resolve(new Response(Uint8Array.from({ length: end - start + 1 }, (_, i) => (start + i) % 251), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}` } })); });
	});
	try {
		const input = new HttpStream({ url: 'https://video.example/movie' });
		const got: number[] = [];
		const lane = (start: number, signal?: AbortSignal) => input.read(start, HTTP_FEED_CHUNK, offset => { got.push(offset); }, signal);
		const own = new AbortController();
		const a = lane(0), b = lane(HTTP_FEED_CHUNK, own.signal), c = lane(2 * HTTP_FEED_CHUNK);
		await until(() => releases.length === 3);
		assert.equal(peak, HTTP_LANES);
		await assert.rejects(lane(3 * HTTP_FEED_CHUNK), /Too many concurrent/);
		own.abort();
		await assert.rejects(b, { name: 'AbortError' });
		releases[0](); releases[2]();
		await Promise.all([a, c]);
		assert.deepEqual(got.sort((x, y) => x - y), [0, 2 * HTTP_FEED_CHUNK]);
		assert.equal(active, 0);
		const d = lane(0), e = lane(HTTP_FEED_CHUNK);
		await until(() => releases.length === 5);
		input.cancel();
		await assert.rejects(d, { name: 'AbortError' }); await assert.rejects(e, { name: 'AbortError' });
		assert.equal(active, 0);
		deny = 1;
		const retried = lane(0);
		await until(() => releases.length === 6); releases[5]();
		await retried;
		assert.equal(input.throttled, 1); assert.equal(input.retries, 1); assert.equal(active, 0);
	} finally { globalThis.fetch = original; }
});

test('HTTP accepts complete delivery when the final retry fails while closing', async () => {
	const original = globalThis.fetch;
	let calls = 0, delivered = false;
	globalThis.fetch = async () => {
		if (++calls < 4) return new Response(null, { status: 503 });
		return new Response(new ReadableStream<Uint8Array>({
			pull(controller) {
				if (delivered) controller.error(new Error('Connection closed after delivery'));
				else { delivered = true; controller.enqueue(new Uint8Array([7])); }
			},
		}, { highWaterMark: 0 }), { status: 206, headers: { 'Content-Range': 'bytes 0-0/1' } });
	};
	try {
		const input = new HttpStream({ url: 'https://video.example/movie' });
		assert.deepEqual(await readRange(input, 0, 1), Buffer.from([7]));
		assert.equal(calls, 4);
		assert.equal(input.retries, 3);
	} finally { globalThis.fetch = original; }
});
