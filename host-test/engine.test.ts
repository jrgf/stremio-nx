import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_SIZE } from '../src/torrent/constants';
import { pickFile, TorrentEngine } from '../src/torrent/engine';
import { InfoHash, type TorrentInfo } from '../src/torrent/types';
import { makeTorrent } from './fixtures';
import { runMockPeer, waitFor } from './mock-peer';
import { nodePlatform } from './node-platform';

function info(files: { length: number }[]): TorrentInfo {
	let offset = 0;
	return {
		infoHash: InfoHash.fromHex('00'.repeat(20)),
		name: 't',
		pieceLength: 16384,
		pieceHashes: [],
		files: files.map((f, i) => ({ path: [`f${i}`], length: f.length, offset: (offset += f.length) - f.length })),
		totalLength: files.reduce((n, f) => n + f.length, 0),
	};
}

test('pickFile chooses the largest file by default', () => {
	const t = info([{ length: 100 }, { length: 5000 }, { length: 200 }]);
	assert.equal(pickFile(t, null).length, 5000);
	assert.equal(pickFile(t, null).offset, 100);
});

test('pickFile honors an explicit index and range-checks it', () => {
	const t = info([{ length: 100 }, { length: 5000 }]);
	assert.equal(pickFile(t, 0).length, 100);
	assert.throws(() => pickFile(t, 5), /out of range/);
});

test('a block arriving from one peer is cancelled at the others racing it', async () => {
	// One piece of one block, seeded by a fast and a slow mock peer. The
	// critical window races the block across both; the slow one must get a
	// CANCEL once the fast one delivers.
	const { info, data } = makeTorrent(1, BLOCK_SIZE, BLOCK_SIZE);
	const cancels: string[] = [];
	const fast = nodePlatform.listen(18495, (conn) => void runMockPeer(conn, info.infoHash.bytes, data), '127.0.0.1');
	const slow = nodePlatform.listen(
		18496,
		(conn) =>
			void runMockPeer(conn, info.infoHash.bytes, data, undefined, {
				blockDelayMs: 1500,
				onMessage: (m) => { if (m.type === 'cancel') cancels.push(`${m.index}:${m.begin}:${m.length}`); },
			}),
		'127.0.0.1',
	);
	const engine = new TorrentEngine(nodePlatform, { info, maxPeers: 2 });
	try {
		await engine.prepare({ infoHash: info.infoHash, announce: [], fileIdx: null });
		engine.addPeers([{ ip: '127.0.0.1', port: 18495 }, { ip: '127.0.0.1', port: 18496 }]);
		await waitFor(() => engine.bufferedFrom(0) === BLOCK_SIZE, 4000);
		await waitFor(() => cancels.length > 0, 1000);
		assert.deepEqual(cancels, [`0:0:${BLOCK_SIZE}`]);
		assert.deepEqual(engine.read(0, BLOCK_SIZE), data);
	} finally {
		engine.stop();
		fast.close();
		slow.close();
	}
});
