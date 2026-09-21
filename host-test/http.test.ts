/**
 * Host tests for the local HTTP server: request parsing, keep-alive and
 * range responses, driven through a real TCP socket on Node.
 * Run with `npm run host-test:http`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveConnection, text } from '../src/server/http';
import { chunked, parseRange, rangeResponse } from '../src/server/range';
import { nodePlatform } from './node-platform';

const FILE = new Uint8Array(1000).map((_, i) => i & 0xff);
const PORT = 18470;

const server = nodePlatform.listen(PORT, (conn) =>
	void serveConnection(conn, async (req) =>
		req.path === '/file'
			? rangeResponse(req, FILE.length, 'application/octet-stream', chunked(300, async (s, e) => FILE.slice(s, e)))
			: text(404, 'nope'),
	),
);

test.after(() => server.close());

test('parseRange', () => {
	assert.deepEqual(parseRange(undefined, 100), null);
	assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 100 });
	assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 20 });
	assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 100 });
	assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 100 });
	assert.equal(parseRange('bytes=100-', 100), 'invalid');
	assert.equal(parseRange('bytes=5-2', 100), 'invalid');
	assert.equal(parseRange('items=0-1', 100), 'invalid');
});

test('full GET, then a range on the same keep-alive connection', async () => {
	const full = await fetch(`http://127.0.0.1:${PORT}/file`);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get('accept-ranges'), 'bytes');
	assert.deepEqual(new Uint8Array(await full.arrayBuffer()), FILE);

	const part = await fetch(`http://127.0.0.1:${PORT}/file`, { headers: { Range: 'bytes=250-649' } });
	assert.equal(part.status, 206);
	assert.equal(part.headers.get('content-range'), 'bytes 250-649/1000');
	assert.deepEqual(new Uint8Array(await part.arrayBuffer()), FILE.slice(250, 650));
});

test('open-ended range, HEAD, unsatisfiable range, 404', async () => {
	const tail = await fetch(`http://127.0.0.1:${PORT}/file`, { headers: { Range: 'bytes=990-' } });
	assert.equal(tail.status, 206);
	assert.equal((await tail.arrayBuffer()).byteLength, 10);

	const head = await fetch(`http://127.0.0.1:${PORT}/file`, { method: 'HEAD' });
	assert.equal(head.headers.get('content-length'), '1000');
	assert.equal((await head.arrayBuffer()).byteLength, 0);

	const bad = await fetch(`http://127.0.0.1:${PORT}/file`, { headers: { Range: 'bytes=5000-' } });
	assert.equal(bad.status, 416);
	assert.equal(bad.headers.get('content-range'), 'bytes */1000');

	const missing = await fetch(`http://127.0.0.1:${PORT}/other`);
	assert.equal(missing.status, 404);
	assert.equal(await missing.text(), 'nope');
});
