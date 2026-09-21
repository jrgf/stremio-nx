/**
 * Host tests for the peer wire: bitfield, message framing, and a full Peer
 * handshake + download against a mock peer over loopback TCP.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bitfield } from '../src/torrent/bitfield';
import { keepAlive, Peer } from '../src/torrent/wire/peer';
import { decodeMessage, encodeHandshake, frame, messages, parseHandshake } from '../src/torrent/wire/messages';
import { concat, runMockPeer, u32, waitFor } from './mock-peer';
import { nodePlatform } from './node-platform';

test('bitfield has/set/count with MSB-first bit order', () => {
	const bf = new Bitfield(16);
	bf.set(0);
	bf.set(9);
	assert.ok(bf.has(0));
	assert.ok(bf.has(9));
	assert.ok(!bf.has(1));
	assert.equal(bf.bytes[0], 0x80);
	assert.equal(bf.bytes[1], 0x40);
	assert.equal(bf.count(), 2);
	assert.ok(!new Bitfield(8).has(100));
});

test('handshake encode/parse round-trip with extension bit', () => {
	const infoHash = new Uint8Array(20).fill(7);
	const peerId = new Uint8Array(20).fill(9);
	const hs = parseHandshake(encodeHandshake(infoHash, peerId));
	assert.ok(hs);
	assert.equal(hs.extensions, true);
	assert.deepEqual(hs.infoHash, infoHash);
	assert.deepEqual(hs.peerId, peerId);
	assert.equal(parseHandshake(new Uint8Array(10)), null);
});

test('keep-alive is a zero-length frame', () => {
	assert.deepEqual([...keepAlive()], [0, 0, 0, 0]);
});

test('message framing round-trips', () => {
	assert.deepEqual(decodeMessage(frame(null).subarray(4)), { type: 'keepAlive' });
	assert.deepEqual(decodeMessage(messages.interested().subarray(4)), { type: 'interested' });
	assert.deepEqual(decodeMessage(messages.have(5).subarray(4)), { type: 'have', index: 5 });
	assert.deepEqual(decodeMessage(messages.request(1, 2, 3).subarray(4)), {
		type: 'request', index: 1, begin: 2, length: 3,
	});
	const piece = frame(7, concat(u32(1), u32(16384), new Uint8Array([1, 2, 3])));
	const decoded = decodeMessage(piece.subarray(4));
	assert.equal(decoded.type, 'piece');
	if (decoded.type === 'piece') {
		assert.equal(decoded.index, 1);
		assert.equal(decoded.begin, 16384);
		assert.deepEqual(decoded.block, new Uint8Array([1, 2, 3]));
	}
});

test('Peer: handshake, extended handshake, unchoke, piece, metadata over loopback', async () => {
	const infoHash = new Uint8Array(20).fill(3);
	const clientId = new Uint8Array(20).fill(1);
	const block = new Uint8Array([10, 20, 30, 40]);
	const metadataBytes = new TextEncoder().encode('METADATA-BYTES');

	const listener = nodePlatform.listen(18492, (conn) => void runMockPeer(conn, infoHash, block, metadataBytes), '127.0.0.1');

	const received: { bitfield?: number; unchoke?: boolean; piece?: Uint8Array; metadata?: Uint8Array } = {};
	const done = Promise.withResolvers<void>();
	try {
		const peer = await Peer.connect(nodePlatform, { ip: '127.0.0.1', port: 18492 }, infoHash, clientId, {
			onBitfield: (bf) => { received.bitfield = bf.count(); },
			onUnchoke: () => { received.unchoke = true; },
			onPiece: (_i, _b, blk) => { received.piece = blk; },
			onMetadata: (payload) => { received.metadata = payload; done.resolve(); },
			onExtendedHandshake: () => {},
		});
		// Wait for the extended handshake to land, then drive requests.
		await waitFor(() => peer.utMetadataId !== undefined);
		assert.equal(peer.utMetadataId, 2);
		assert.equal(peer.metadataSize, metadataBytes.length);

		await peer.sendInterested();
		await waitFor(() => received.unchoke === true);
		await peer.requestBlock(0, 0, block.length);
		await waitFor(() => received.piece !== undefined);
		await peer.requestMetadata(0);
		await done.promise;

		assert.equal(received.bitfield, 1);
		assert.deepEqual(received.piece, block);
		// metadata payload = bencode dict + trailing data bytes.
		assert.ok(received.metadata && endsWith(received.metadata, metadataBytes));
		await peer.close();
	} finally {
		listener.close();
	}
});

function endsWith(buf: Uint8Array, suffix: Uint8Array): boolean {
	if (buf.length < suffix.length) return false;
	for (let i = 0; i < suffix.length; i++) if (buf[buf.length - suffix.length + i] !== suffix[i]) return false;
	return true;
}
