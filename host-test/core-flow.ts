/**
 * Host run of the control path with the real stremio-core on Node: our
 * loopback control server answers the core's streaming-server probes, the
 * core loads a public-domain title's details, we take the first torrent
 * stream it offers, load the core Player with it, and print the torrent
 * request the app would hand to the engine. Run: npm run core-flow [imdb-id...]
 */
import { createControlHandler } from '../src/server/control';
import { serveConnection } from '../src/server/http';
import { installShims, MemoryStore } from '../src/shims';
import { StremioClient, torrentRequestFromStream } from '../src/stremio/client';
import { nodePlatform } from './node-platform';

const IDS = process.argv.length > 2 ? process.argv.slice(2) : ['tt0063350']; // Night of the Living Dead (public domain)
const PORT = 11470;
const BASE = `http://127.0.0.1:${PORT}/`;

async function main() {
	const log = (m: string) => console.log(`[core] ${m}`);
	const listener = nodePlatform.listen(
		PORT,
		(conn) =>
			void serveConnection(
				conn,
				createControlHandler({
					baseUrl: BASE,
					localIp: () => '127.0.0.1',
					createTorrent: (h, a) => log(`create ${h} trackers=${a.length}`),
					statistics: () => null,
				}),
			),
		'127.0.0.1',
	);
	try {
		installShims({ appVersion: '0.1.0', shellVersion: 'stremio-nx-host', storage: new MemoryStore() });
		const core = await StremioClient.create({ log });
		const server = await core.reloadStreamingServer();
		console.log(`[flow] streaming server model: settings ${server.settings.type}, base ${server.baseUrl}, network ${server.networkInfo.type}, device ${server.deviceInfo.type}`);
		if (server.settings.type !== 'Ready') throw new Error(`streaming server probe failed: ${JSON.stringify(server.settings).slice(0, 200)}`);

		let last: Awaited<ReturnType<StremioClient['loadMetaDetails']>> | undefined;
		for (const id of IDS) {
			last = await core.loadMetaDetails('movie', id);
			console.log(`[flow] ${id}: ${last.meta.name}, ${last.streams.length} streams`);
			for (const s of last.streams) {
				const tag = s.stream.infoHash ? `torrent ${s.stream.infoHash.slice(0, 8)} fileIdx=${s.stream.fileIdx}` : s.stream.url ? 'url' : s.stream.ytId ? 'yt' : 'other';
				console.log(`[flow]   - ${s.addonName}: ${tag} | ${s.stream.name ?? ''} ${String(s.stream.title ?? s.stream.description ?? '').replace(/\n/g, ' ').slice(0, 60)}`);
			}
		}
		const option = last?.streams.find((s) => s.stream.infoHash);
		if (!last || !option) throw new Error('no torrent stream offered');
		const selected = await core.loadPlayer(option, last.meta);
		const request = torrentRequestFromStream(selected);
		if (!request) throw new Error('selected stream is not a torrent');
		console.log(`[flow] core selected torrent ${request.infoHash.toHex()} fileIdx=${request.fileIdx} announce=${request.announce.length}`);
		console.log('[flow] PASS: control path yields a torrent request');
		process.exit(0);
	} finally {
		listener.close();
	}
}

main().catch((err) => { console.error('[flow] FAILED:', err instanceof Error ? err.stack : err); process.exit(1); });
