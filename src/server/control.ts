/**
 * The streaming-server control surface stremio-core expects on
 * http://127.0.0.1:11470/: the probe endpoints its StreamingServer model
 * polls (settings, casting, network-info, device-info), settings updates,
 * torrent creation, and per-torrent statistics. Tiny request/response only:
 * media bytes never go through here (the player feeds the decoder directly).
 */
import { json, text, type HttpHandler, type HttpRequest } from './http';

export interface TorrentStatistics {
	name: string;
	infoHash: string;
	files: { name: string; path: string; length: number; offset: number }[];
	sources: unknown[];
	opts: Record<string, unknown>;
	downloadSpeed: number;
	uploadSpeed: number;
	downloaded: number;
	uploaded: number;
	unchoked: number;
	peers: number;
	queued: number;
	unique: number;
	connectionTries: number;
	peerSearchRunning: boolean;
	streamLen: number;
	streamName: string;
	streamProgress: number;
	swarmConnections: number;
	swarmPaused: boolean;
	swarmSize: number;
}

export interface ControlDeps {
	/** Public base of this server, e.g. `http://127.0.0.1:11470/`. */
	baseUrl: string;
	localIp: () => string;
	/** Start (or reuse) a torrent session; `announce` holds tracker URLs. */
	createTorrent: (infoHash: string, announce: string[]) => void;
	statistics: (infoHash: string, fileIdx: number) => TorrentStatistics | null;
}

const INFO_HASH = /^[0-9a-f]{40}$/i;
const SERVER_VERSION = 'stremio-nx 0.1';

export function serverSettings(baseUrl: string) {
	return {
		baseUrl,
		values: {
			appPath: 'sdmc:/switch/stremio-nx',
			cacheRoot: 'sdmc:/switch/stremio-nx',
			serverVersion: SERVER_VERSION,
			remoteHttps: '',
			transcodeProfile: null,
			cacheSize: 0,
			proxyStreamsEnabled: false,
			btMaxConnections: 20,
			btHandshakeTimeout: 20000,
			btRequestTimeout: 8000,
			btDownloadSpeedSoftLimit: 0,
			btDownloadSpeedHardLimit: 0,
			btMinPeersForStable: 5,
		},
		options: [],
	};
}

export function createControlHandler(deps: ControlDeps): HttpHandler {
	return async (req: HttpRequest) => {
		const parts = req.path.split('/').filter(Boolean);
		if (parts.length === 0) return text(200, SERVER_VERSION);
		if (parts.length === 1) {
			switch (parts[0]) {
				case 'settings':
					return req.method === 'POST' ? json(200, { success: true }) : json(200, serverSettings(deps.baseUrl));
				case 'casting':
					return json(200, []);
				case 'network-info':
					return json(200, { availableInterfaces: [deps.localIp()] });
				case 'device-info':
					return json(200, { availableHardwareAccelerations: [] });
			}
		}
		if (INFO_HASH.test(parts[0])) {
			const infoHash = parts[0].toLowerCase();
			if (parts.length === 2 && parts[1] === 'create' && req.method === 'POST') {
				deps.createTorrent(infoHash, trackersFromCreateBody(req.body));
				return json(200, { infoHash });
			}
			if (parts.length === 3 && parts[2] === 'stats.json') {
				const fileIdx = Number(parts[1]);
				return json(200, Number.isInteger(fileIdx) ? deps.statistics(infoHash, fileIdx) : null);
			}
		}
		return text(404, 'not found');
	};
}

/** Tracker URLs from the core's create body (`peerSearch.sources`: `tracker:<url>` / `dht:<hash>`). */
function trackersFromCreateBody(body: Uint8Array): string[] {
	if (body.length === 0) return [];
	try {
		const parsed = JSON.parse(new TextDecoder().decode(body)) as { peerSearch?: { sources?: string[] } };
		return (parsed.peerSearch?.sources ?? [])
			.filter((s) => s.startsWith('tracker:'))
			.map((s) => s.slice('tracker:'.length));
	} catch {
		return [];
	}
}
