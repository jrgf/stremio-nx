/**
 * Live DHT check from the host: look up peers for the Sintel info hash using
 * only the public bootstrap routers (no trackers). Prints peers as they arrive
 * and the totals. Run: npm run dht-live
 */
import { DhtClient } from '../src/torrent/dht';
import { parseMagnet } from '../src/torrent/metainfo';
import { nodePlatform } from './node-platform';

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel';

async function main() {
	const request = parseMagnet(MAGNET);
	const dht = new DhtClient(nodePlatform, { log: (m) => console.log(`[dht] ${m}`) });
	const t0 = Date.now();
	let first = 0;
	let total = 0;
	const result = await dht.getPeers(request.infoHash.bytes, (peers) => {
		total += peers.length;
		if (!first) first = Date.now() - t0;
		console.log(`[test] +${peers.length} peers at ${((Date.now() - t0) / 1000).toFixed(1)}s (total ${total})`);
	}, { maxPeers: 60 });
	console.log(`[test] ${result.peers} peers, ${result.responded}/${result.queried} nodes answered, ${((Date.now() - t0) / 1000).toFixed(1)}s, first peers after ${(first / 1000).toFixed(1)}s`);
	dht.stop();
	console.log(result.peers > 0 ? '[test] PASS: DHT finds peers' : '[test] FAIL: no peers via DHT');
	process.exit(result.peers > 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('[test] FAILED:', err.message);
	process.exit(1);
});
