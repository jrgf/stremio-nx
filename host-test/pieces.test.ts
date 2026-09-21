/**
 * Host tests for the piece manager: block assembly + SHA-1 verify (pass/fail),
 * read-head request priority, in-flight dedup and timeout, reads, eviction.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_SIZE } from '../src/torrent/constants';
import { PieceManager } from '../src/torrent/pieces';
import { makeTorrent } from './fixtures';
import { nodePlatform } from './node-platform';

async function feedPiece(pm: PieceManager, data: Uint8Array, pieceLength: number, index: number, corrupt = false) {
	const size = pm.pieceSize(index);
	let last: string = 'partial';
	for (let begin = 0; begin < size; begin += BLOCK_SIZE) {
		const len = Math.min(BLOCK_SIZE, size - begin);
		const block = data.subarray(index * pieceLength + begin, index * pieceLength + begin + len).slice();
		if (corrupt && begin === 0) block[0] ^= 0xff;
		last = await pm.onBlock(index, begin, block);
	}
	return last;
}

test('long playback and seeks release partial pieces and ignore stale verification', async () => {
	const pieceLength = 2 * BLOCK_SIZE;
	const { info, data } = makeTorrent(64, pieceLength, pieceLength);
	const pm = new PieceManager(info, nodePlatform);
	for (let n = 0; n < 1000; n++) {
		const index = n % 60;
		pm.setReadHead(index * pieceLength);
		pm.retainRange(index * pieceLength, (index + 4) * pieceLength);
		await feedPiece(pm, data, pieceLength, index);
		await pm.onBlock(index + 3, 0, data.subarray((index + 3) * pieceLength, (index + 3) * pieceLength + BLOCK_SIZE));
		const memory = pm.memoryUsage();
		assert.ok(memory.cachedBytes + memory.partialBytes <= 4 * pieceLength);
	}
	pm.retainRange(0, 0);
	assert.deepEqual(pm.memoryUsage(), { cachedBytes: 0, partialBytes: 0 });
	assert.equal(await pm.onBlock(10, 0, data.subarray(0, BLOCK_SIZE)), 'ignored');
	let finish!: (hash: Uint8Array) => void;
	const hashing = new PieceManager(info, { ...nodePlatform, sha1: () => new Promise(resolve => { finish = resolve; }) });
	await hashing.onBlock(0, 0, data.subarray(0, BLOCK_SIZE));
	const pending = hashing.onBlock(0, BLOCK_SIZE, data.subarray(BLOCK_SIZE, pieceLength));
	hashing.retainRange(pieceLength, 2 * pieceLength);
	finish(info.pieceHashes[0]);
	assert.equal(await pending, 'ignored');
	assert.equal(hashing.hasPiece(0), false);
	assert.deepEqual(hashing.memoryUsage(), { cachedBytes: 0, partialBytes: 0 });
	assert.equal(await hashing.onBlock(1, -BLOCK_SIZE, data.subarray(0, BLOCK_SIZE)), 'ignored');
	assert.equal(await hashing.onBlock(1, 0, new Uint8Array(1)), 'ignored');
	assert.equal(hashing.memoryUsage().partialBytes, 0);
});

test('assembles and verifies a piece; rejects a corrupt one', async () => {
	const pieceLength = BLOCK_SIZE * 3;
	const { info, data } = makeTorrent(4, pieceLength, BLOCK_SIZE);
	const pm = new PieceManager(info, nodePlatform);

	assert.equal(await feedPiece(pm, data, pieceLength, 0), 'completed');
	assert.ok(pm.hasPiece(0));
	assert.equal(await feedPiece(pm, data, pieceLength, 1, true), 'failed');
	assert.ok(!pm.hasPiece(1));
	// Last piece is short (one block).
	assert.equal(pm.pieceSize(3), BLOCK_SIZE);
	assert.equal(await feedPiece(pm, data, pieceLength, 3), 'completed');
});

test('read returns contiguous verified bytes and stops at the first gap', async () => {
	const pieceLength = BLOCK_SIZE * 2;
	const { info, data } = makeTorrent(4, pieceLength, pieceLength);
	const pm = new PieceManager(info, nodePlatform);
	await feedPiece(pm, data, pieceLength, 0);
	await feedPiece(pm, data, pieceLength, 1);
	// pieces 0,1 present; piece 2 missing.
	const got = pm.read(100, pieceLength * 3);
	assert.deepEqual(got, data.subarray(100, pieceLength * 2));
	assert.equal(pm.bufferedFrom(0), pieceLength * 2);
});

test('pickRequests prioritizes the read head and dedupes in-flight', async () => {
	const pieceLength = BLOCK_SIZE; // one block per piece
	const { info } = makeTorrent(10, pieceLength, pieceLength);
	const pm = new PieceManager(info, nodePlatform);
	pm.setReadHead(pieceLength * 5); // read head at piece 5

	const reqs = pm.pickRequests(() => true, 3, 1000);
	assert.deepEqual(reqs.map((r) => r.index), [5, 6, 7]); // head-first order

	// Re-picking immediately skips the in-flight blocks (forward-only: 8,9 then end).
	const again = pm.pickRequests(() => true, 3, 1500);
	assert.deepEqual(again.map((r) => r.index), [8, 9]);

	// After the timeout, the earlier in-flight blocks are eligible again.
	const later = pm.pickRequests(() => true, 2, 1000 + 20000);
	assert.deepEqual(later.map((r) => r.index), [5, 6]);
});

test('pickRequests skips pieces the peer lacks', async () => {
	const pieceLength = BLOCK_SIZE;
	const { info } = makeTorrent(5, pieceLength, pieceLength);
	const pm = new PieceManager(info, nodePlatform);
	const reqs = pm.pickRequests((i) => i === 3, 5, 1000);
	assert.deepEqual(reqs.map((r) => r.index), [3]);
});

test('an evicted piece is forgotten and re-fetched when the head returns (moov-at-end seek)', async () => {
	const pieceLength = BLOCK_SIZE;
	const { info, data } = makeTorrent(6, pieceLength, pieceLength);
	const pm = new PieceManager(info, nodePlatform);
	await feedPiece(pm, data, pieceLength, 0);
	assert.ok(pm.hasPiece(0));
	// Decoder probed the end, so we evicted the start.
	pm.evictBefore(pieceLength * 3);
	assert.ok(!pm.hasPiece(0), 'evicted piece is forgotten');
	assert.equal(pm.read(0, pieceLength).length, 0);
	// Head returns to the start (seek back): the picker offers piece 0 again.
	pm.setReadHead(0);
	assert.ok(pm.pickRequests(() => true, 1, 1000).some((r) => r.index === 0), 're-fetches evicted piece');
	await feedPiece(pm, data, pieceLength, 0);
	assert.equal(pm.read(0, pieceLength).length, pieceLength, 'readable again after re-fetch');
});

test('evictBefore frees cached pieces behind the read head', async () => {
	const pieceLength = BLOCK_SIZE;
	const { info, data } = makeTorrent(6, pieceLength, pieceLength);
	const pm = new PieceManager(info, nodePlatform);
	for (let i = 0; i < 6; i++) await feedPiece(pm, data, pieceLength, i);
	assert.equal(pm.read(0, pieceLength).length, pieceLength);
	pm.evictBefore(pieceLength * 3);
	// Pieces 0-2 evicted; a read at 0 now returns nothing, a read at piece 3 works.
	assert.equal(pm.read(0, pieceLength).length, 0);
	assert.equal(pm.read(pieceLength * 3, pieceLength).length, pieceLength);
});

test('pickRequests stays within the request window from the read head', async () => {
	const pieceLength = BLOCK_SIZE;
	const { info } = makeTorrent(10, pieceLength, pieceLength);
	const pm = new PieceManager(info, nodePlatform);
	pm.setReadHead(pieceLength * 2);
	// Window of 3 pieces: only 2,3,4 are eligible even though more were asked for.
	const reqs = pm.pickRequests(() => true, 8, 1000, 0, 3);
	assert.deepEqual(reqs.map((r) => r.index), [2, 3, 4]);
	// With those in flight, nothing else is eligible inside the window.
	assert.deepEqual(pm.pickRequests(() => true, 8, 1500, 0, 3), []);
});
