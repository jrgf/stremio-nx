/**
 * Host tests for the tracker layer: peer parsing, percent-encoding, a UDP
 * announce round-trip against a mock BEP-15 tracker, and an HTTP announce
 * against our own server returning a bencoded compact-peer response.
 */
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { encode, type Bencode } from '../src/torrent/bencode';
import { serveConnection } from '../src/server/http';
import { announceHttp, percentEncode } from '../src/torrent/tracker/http';
import { announceUdp } from '../src/torrent/tracker/udp';
import { announceAll } from '../src/torrent/tracker';
import { dedupePeers, parseCompactPeers, parsePeers } from '../src/torrent/tracker/peers';
import { nodePlatform } from './node-platform';

const bytes = (s: string) => new TextEncoder().encode(s);
// Two peers: 1.2.3.4:0x1234 and 5.6.7.8:0x5678.
const COMPACT = new Uint8Array([1, 2, 3, 4, 0x12, 0x34, 5, 6, 7, 8, 0x56, 0x78]);

test('parseCompactPeers and dict peers', () => {
	assert.deepEqual(parseCompactPeers(COMPACT), [
		{ ip: '1.2.3.4', port: 0x1234 },
		{ ip: '5.6.7.8', port: 0x5678 },
	]);
	const dictForm: Bencode = [
		new Map<string, Bencode>([['ip', bytes('9.9.9.9')], ['port', 6881]]),
	];
	assert.deepEqual(parsePeers(dictForm), [{ ip: '9.9.9.9', port: 6881 }]);
	assert.throws(() => parseCompactPeers(new Uint8Array(5)), /multiple of 6/);
});

test('dedupePeers removes ip:port duplicates', () => {
	const deduped = dedupePeers([
		{ ip: '1.1.1.1', port: 1 },
		{ ip: '1.1.1.1', port: 1 },
		{ ip: '1.1.1.1', port: 2 },
	]);
	assert.equal(deduped.length, 2);
});

test('percentEncode escapes non-unreserved bytes', () => {
	assert.equal(percentEncode(new Uint8Array([0x00, 0x2f, 0x41, 0x7e])), '%00%2FA~');
});

test('announceUdp completes a connect+announce round-trip (BEP 15)', async () => {
	const server = dgram.createSocket('udp4');
	const connId = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]);
	server.on('message', (msg, rinfo) => {
		const action = msg.readUInt32BE(8);
		const txid = msg.subarray(12, 16);
		if (action === 0) {
			// connect -> [action=0][txid][connection_id]
			const res = Buffer.concat([Buffer.alloc(4), txid, connId]);
			server.send(res, rinfo.port, rinfo.address);
		} else if (action === 1) {
			// announce -> [action=1][txid][interval][leechers][seeders][peers]
			const head = Buffer.alloc(20);
			head.writeUInt32BE(1, 0);
			txid.copy(head, 4);
			head.writeUInt32BE(900, 8); // interval
			server.send(Buffer.concat([head, Buffer.from(COMPACT)]), rinfo.port, rinfo.address);
		}
	});
	await new Promise<void>((r) => server.bind(0, r));
	const port = server.address().port;
	try {
		const result = await announceUdp(`udp://127.0.0.1:${port}`, {
			infoHash: new Uint8Array(20),
			peerId: new Uint8Array(20),
			port: 6881,
			left: 1000,
		}, nodePlatform);
		assert.equal(result.intervalSeconds, 900);
		assert.deepEqual(result.peers, parseCompactPeers(COMPACT));
	} finally {
		server.close();
	}
});

test('announceHttp parses a bencoded compact-peer response', async () => {
	const body = encode(new Map<string, Bencode>([['interval', 1200], ['peers', COMPACT]]));
	const PORT = 18490;
	const listener = nodePlatform.listen(PORT, (conn) =>
		void serveConnection(conn, async () => ({
			status: 200,
			headers: { 'Content-Type': 'text/plain' },
			body,
		})),
		'127.0.0.1',
	);
	try {
		const result = await announceHttp(`http://127.0.0.1:${PORT}/announce`, {
			infoHash: new Uint8Array(20),
			peerId: new Uint8Array(20),
			port: 6881,
			left: 1000,
		});
		assert.equal(result.intervalSeconds, 1200);
		assert.deepEqual(result.peers, parseCompactPeers(COMPACT));
	} finally {
		listener.close();
	}
});

test('announceAll reports each tracker as it answers, before slow ones finish', async () => {
	const COMPACT2 = new Uint8Array([9, 9, 9, 9, 0x00, 0x50]); // 9.9.9.9:80
	const respond = (peers: Uint8Array, delayMs: number) => async () => {
		if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
		return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: encode(new Map<string, Bencode>([['interval', 60], ['peers', peers]])) };
	};
	const fast = nodePlatform.listen(18493, (conn) => void serveConnection(conn, respond(COMPACT, 0)), '127.0.0.1');
	const slow = nodePlatform.listen(18494, (conn) => void serveConnection(conn, respond(COMPACT2, 400)), '127.0.0.1');
	try {
		const t0 = Date.now();
		const arrivals: number[] = [];
		const result = await announceAll(
			['http://127.0.0.1:18493/announce', 'http://127.0.0.1:18494/announce'],
			{ infoHash: new Uint8Array(20), peerId: new Uint8Array(20), port: 6881, left: 1000 },
			nodePlatform,
			() => arrivals.push(Date.now() - t0),
		);
		assert.equal(arrivals.length, 2);
		assert.ok(arrivals[0] < 300, `first tracker reported at ${arrivals[0]} ms, before the slow one`);
		assert.ok(arrivals[1] >= 400);
		assert.equal(result.peers.length, 3);
		assert.equal(result.errors.length, 0);
	} finally {
		fast.close();
		slow.close();
	}
});
