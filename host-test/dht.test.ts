/**
 * Host tests for the DHT client: KRPC codec, compact node info, XOR ordering,
 * and an iterative get_peers lookup across two mock nodes over loopback UDP
 * (the first hands back closer nodes, the second hands back peers).
 */
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { encode, type Bencode } from '../src/torrent/bencode';
import { DhtClient } from '../src/torrent/dht';
import { compareDistance, decodeMessage, encodeCompactNodes, encodeQuery, encodeResponse, parseCompactNodes } from '../src/torrent/dht/krpc';
import { nodePlatform } from './node-platform';

const str = (s: string) => new TextEncoder().encode(s);

test('krpc query/response/error round-trip', () => {
	const t = new Uint8Array([0xaa, 0x01]);
	const q = decodeMessage(encodeQuery(t, 'ping', new Map<string, Bencode>([['id', new Uint8Array(20).fill(7)]])));
	assert.equal(q.type, 'query');
	if (q.type === 'query') {
		assert.deepEqual(q.t, t);
		assert.equal(q.q, 'ping');
		assert.equal((q.a.get('id') as Uint8Array).length, 20);
	}
	const r = decodeMessage(encodeResponse(t, new Map<string, Bencode>([['id', new Uint8Array(20)]])));
	assert.equal(r.type, 'response');
	const e = decodeMessage(encode(new Map<string, Bencode>([['t', t], ['y', str('e')], ['e', [203, str('Protocol Error')]]])));
	assert.deepEqual(e, { type: 'error', t, code: 203, message: 'Protocol Error' });
});

test('compact node info round-trips and XOR distance orders toward the target', () => {
	const a = { id: new Uint8Array(20).fill(0x0f), ip: '10.1.2.3', port: 6881 };
	const b = { id: new Uint8Array(20).fill(0xf0), ip: '192.168.0.1', port: 51413 };
	const parsed = parseCompactNodes(encodeCompactNodes([a, b]));
	assert.deepEqual(parsed, [a, b]);
	const target = new Uint8Array(20).fill(0x0e); // closer to a
	assert.ok(compareDistance(a.id, b.id, target) < 0);
	assert.ok(compareDistance(b.id, a.id, target) > 0);
	assert.equal(compareDistance(a.id, a.id, target), 0);
});

test('get_peers walks from a bootstrap node to a closer node that returns peers', async () => {
	const infoHash = new Uint8Array(20).fill(0x55);
	const farId = new Uint8Array(20).fill(0xaa);
	const nearId = new Uint8Array(20).fill(0x54);
	const near = dgram.createSocket('udp4');
	const far = dgram.createSocket('udp4');
	await new Promise<void>((r) => near.bind(0, '127.0.0.1', r));
	await new Promise<void>((r) => far.bind(0, '127.0.0.1', r));
	const nearPort = near.address().port;
	const queries: string[] = [];
	far.on('message', (msg, rinfo) => {
		const m = decodeMessage(new Uint8Array(msg));
		if (m.type !== 'query') return;
		queries.push(`far:${m.q}`);
		assert.equal(m.q, 'get_peers');
		assert.deepEqual(m.a.get('info_hash'), infoHash);
		const nodes = encodeCompactNodes([{ id: nearId, ip: '127.0.0.1', port: nearPort }]);
		far.send(encodeResponse(m.t, new Map<string, Bencode>([['id', farId], ['token', str('tk')], ['nodes', nodes]])), rinfo.port, rinfo.address);
	});
	near.on('message', (msg, rinfo) => {
		const m = decodeMessage(new Uint8Array(msg));
		if (m.type !== 'query') return;
		queries.push(`near:${m.q}`);
		const peer = new Uint8Array([1, 2, 3, 4, 0x1a, 0xe1]); // 1.2.3.4:6881
		near.send(encodeResponse(m.t, new Map<string, Bencode>([['id', nearId], ['token', str('tk')], ['values', [peer]]])), rinfo.port, rinfo.address);
	});
	const dht = new DhtClient(nodePlatform, { bootstrap: [`127.0.0.1:${far.address().port}`], queryTimeoutMs: 500 });
	try {
		const found: string[] = [];
		const result = await dht.getPeers(infoHash, (peers) => found.push(...peers.map((p) => `${p.ip}:${p.port}`)), { timeoutMs: 3000 });
		assert.deepEqual(found, ['1.2.3.4:6881']);
		assert.deepEqual(queries, ['far:get_peers', 'near:get_peers']);
		assert.equal(result.peers, 1);
		assert.equal(result.responded, 2);
	} finally {
		dht.stop();
		near.close();
		far.close();
	}
});

test('a dead bootstrap node just times out; the lookup still ends', async () => {
	const dht = new DhtClient(nodePlatform, { bootstrap: ['127.0.0.1:1'], queryTimeoutMs: 200 });
	try {
		const result = await dht.getPeers(new Uint8Array(20), () => assert.fail('no peers expected'), { timeoutMs: 2000 });
		assert.equal(result.peers, 0);
		assert.equal(result.queried, 1);
	} finally {
		dht.stop();
	}
});
