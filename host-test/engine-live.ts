/**
 * Live end-to-end engine check against the real Sintel swarm (network + trackers
 * required). Not a unit test — run manually: `npm run engine-live`.
 * Verifies: trackers return peers, metadata downloads, pieces verify, and the
 * read head drives download so bytes become available at offset 0.
 */
import { DhtClient } from '../src/torrent/dht';
import { TorrentEngine } from '../src/torrent/engine';
import { parseMagnet } from '../src/torrent/metainfo';
import { nodePlatform } from './node-platform';

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel';
const TRACKERS = [
	'udp://tracker.opentrackr.org:1337/announce',
	'udp://open.tracker.cc:1337/announce',
	'udp://tracker.torrent.eu.org:451/announce',
	'udp://exodus.desync.com:6969/announce',
	'udp://explodie.org:6969/announce',
];
const MiB = 1024 * 1024;
const RUN_MS = 45_000;

async function main() {
	const request = parseMagnet(MAGNET);
	request.announce = [...new Set([...request.announce, ...TRACKERS])];
	const log = (m: string) => console.log(`[engine] ${m}`);
	const dht = new DhtClient(nodePlatform, { log });
	const engine = new TorrentEngine(nodePlatform, { log, maxPeers: 40, dht });

	const t0 = Date.now();
	const { file } = await engine.prepare(request);
	console.log(`[test] metadata in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${file.path.join('/')} ${(file.length / MiB).toFixed(1)} MiB`);

	// Like the app: keep the read head at the contiguous frontier so the engine's
	// request window slides forward as pieces verify.
	const deadline = Date.now() + RUN_MS;
	let firstBytesAt = 0;
	const timer = setInterval(() => {
		const buffered = engine.bufferedFrom(0);
		engine.setReadHead(buffered);
		if (buffered > 0 && !firstBytesAt) firstBytesAt = Date.now();
		const s = engine.stats();
		console.log(`[test] t=${((Date.now() - t0) / 1000).toFixed(0)}s peers ${s.peers} pieces ${s.completedPieces}/${s.totalPieces} buffered@0 ${(buffered / MiB).toFixed(2)} MiB dbg ${JSON.stringify(engine.debug(0))}`);
		if (buffered >= 12 * MiB || Date.now() > deadline) {
			clearInterval(timer);
			const bytes = engine.read(0, 1 * MiB);
			console.log(`[test] read ${bytes.length} bytes at offset 0; first bytes after ${((firstBytesAt - t0) / 1000).toFixed(1)}s`);
			console.log(bytes.length > 0 ? '[test] PASS: verified data streaming' : '[test] INCOMPLETE: no verified data yet');
			engine.stop();
			dht.stop();
			process.exit(bytes.length > 0 ? 0 : 1);
		}
	}, 2000);
}

main().catch((err) => {
	console.error('[test] FAILED:', err.message);
	process.exit(1);
});
