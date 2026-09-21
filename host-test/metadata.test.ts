/**
 * Host test for BEP 9 metadata assembly: split a real info dict into 16 KiB
 * ut_metadata data messages, feed them in a scrambled order, then verify the
 * hash check and parse produce the right torrent.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { encode, type Bencode } from '../src/torrent/bencode';
import { METADATA_PIECE_SIZE } from '../src/torrent/constants';
import { MetadataDownload } from '../src/torrent/metadata';
import { InfoHash } from '../src/torrent/types';
import { nodePlatform } from './node-platform';

const bytes = (s: string) => new TextEncoder().encode(s);

function dataMessage(piece: number, data: Uint8Array, totalSize: number): Uint8Array {
	const dict: Bencode = new Map<string, Bencode>([['msg_type', 1], ['piece', piece], ['total_size', totalSize]]);
	const head = encode(dict);
	const out = new Uint8Array(head.length + data.length);
	out.set(head, 0);
	out.set(data, head.length);
	return out;
}

test('MetadataDownload assembles, verifies, and parses across pieces', async () => {
	// An info dict big enough to span 3 metadata pieces (>32 KiB).
	const pieces = new Uint8Array(20 * 40); // 40 torrent pieces of hashes
	for (let i = 0; i < pieces.length; i++) pieces[i] = i & 0xff;
	const padding = bytes('x'.repeat(40000)); // pad name to force multiple metadata pieces
	const info = new Map<string, Bencode>([
		['name', padding],
		['piece length', 262144],
		['pieces', pieces],
		['length', 262144 * 40],
	]);
	const infoBytes = encode(info);
	const infoHash = new InfoHash(new Uint8Array(createHash('sha1').update(infoBytes).digest()));

	const dl = new MetadataDownload(infoBytes.length);
	assert.ok(dl.numPieces >= 3);

	// Feed pieces in reverse order to exercise out-of-order assembly.
	for (const piece of dl.missing().reverse()) {
		const offset = piece * METADATA_PIECE_SIZE;
		const chunk = infoBytes.subarray(offset, Math.min(offset + METADATA_PIECE_SIZE, infoBytes.length));
		assert.equal(dl.onMessage(dataMessage(piece, chunk, infoBytes.length)), true);
	}
	assert.ok(dl.isComplete());

	const parsed = await dl.finish(infoHash, nodePlatform);
	assert.ok(parsed.infoHash.equals(infoHash));
	assert.equal(parsed.pieceHashes.length, 40);
	assert.equal(parsed.pieceLength, 262144);
});

test('MetadataDownload rejects a hash mismatch and ignores reject messages', async () => {
	const info = encode(new Map<string, Bencode>([['name', bytes('a')], ['piece length', 16384], ['pieces', new Uint8Array(20)], ['length', 100]]));
	const dl = new MetadataDownload(info.length);
	// A reject message delivers no piece.
	const reject = encode(new Map<string, Bencode>([['msg_type', 2], ['piece', 0]]));
	assert.equal(dl.onMessage(reject), false);
	// Deliver the (single) piece, then finish against the WRONG hash.
	dl.onMessage(dataMessage(0, info, info.length));
	await assert.rejects(dl.finish(InfoHash.fromHex('11'.repeat(20)), nodePlatform), /hash mismatch/);
});
