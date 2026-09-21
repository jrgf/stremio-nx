/**
 * Host tests for the loopback control server: the probe endpoints
 * stremio-core's StreamingServer model polls, torrent creation, and
 * statistics, served over our own HTTP server and fetched with Node's fetch.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createControlHandler, type TorrentStatistics } from '../src/server/control';
import { serveConnection } from '../src/server/http';
import { nodePlatform } from './node-platform';

const PORT = 18497;
const BASE = `http://127.0.0.1:${PORT}/`;
const HASH = '11ea02584fa6351956f35671962ab46354d99060';

test('control server answers the probes, create and stats', async () => {
	const created: { infoHash: string; announce: string[] }[] = [];
	const stats: TorrentStatistics = {
		name: 't', infoHash: HASH, files: [], sources: [], opts: {},
		downloadSpeed: 1, uploadSpeed: 0, downloaded: 2, uploaded: 0, unchoked: 3, peers: 3, queued: 0, unique: 3,
		connectionTries: 0, peerSearchRunning: false, streamLen: 4, streamName: 'f', streamProgress: 0.5,
		swarmConnections: 3, swarmPaused: false, swarmSize: 3,
	};
	const handler = createControlHandler({
		baseUrl: BASE,
		localIp: () => '192.168.1.9',
		createTorrent: (infoHash, announce) => created.push({ infoHash, announce }),
		statistics: (infoHash, fileIdx) => (infoHash === HASH && fileIdx === 0 ? stats : null),
	});
	const listener = nodePlatform.listen(PORT, (conn) => void serveConnection(conn, handler), '127.0.0.1');
	try {
		const settings = await (await fetch(`${BASE}settings`)).json();
		assert.equal(settings.baseUrl, BASE);
		assert.equal(typeof settings.values.btMaxConnections, 'number');
		assert.deepEqual(settings.options, []);
		assert.deepEqual(await (await fetch(`${BASE}settings`, { method: 'POST', body: '{}' })).json(), { success: true });
		assert.deepEqual(await (await fetch(`${BASE}casting`)).json(), []);
		assert.deepEqual(await (await fetch(`${BASE}network-info`)).json(), { availableInterfaces: ['192.168.1.9'] });
		assert.deepEqual(await (await fetch(`${BASE}device-info`)).json(), { availableHardwareAccelerations: [] });

		const body = JSON.stringify({ peerSearch: { min: 40, max: 200, sources: [`dht:${HASH}`, 'tracker:udp://t.example:1337/announce'] } });
		const create = await fetch(`${BASE}${HASH.toUpperCase()}/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		assert.equal(create.status, 200);
		assert.deepEqual(created, [{ infoHash: HASH, announce: ['udp://t.example:1337/announce'] }]);

		assert.deepEqual(await (await fetch(`${BASE}${HASH}/0/stats.json`)).json(), stats);
		assert.equal(await (await fetch(`${BASE}${HASH}/1/stats.json`)).json(), null);
		assert.equal((await fetch(`${BASE}nope`)).status, 404);
	} finally {
		listener.close();
	}
});
