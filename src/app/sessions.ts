/**
 * Registry of torrent engines by info hash: one session per torrent, shared
 * by the control server (the core's create/stats calls) and the player.
 */
import type { Platform } from '../platform/types';
import type { TorrentStatistics } from '../server/control';
import { DhtClient } from '../torrent/dht';
import { TorrentEngine } from '../torrent/engine';
import { InfoHash, type TorrentFile, type TorrentInfo, type TorrentRequest } from '../torrent/types';

export interface TorrentSession {
	engine: TorrentEngine;
	/** Resolves once metadata is known and the file to stream is chosen. */
	ready: Promise<{ info: TorrentInfo; file: TorrentFile }>;
}

export interface SessionOptions {
	log: (msg: string) => void;
	/** Trackers added to every torrent (addon streams often carry none). */
	defaultTrackers: string[];
	maxPeers: number;
}

export class TorrentSessions {
	#platform: Platform;
	#opts: SessionOptions;
	#dht: DhtClient;
	#sessions = new Map<string, TorrentSession>();

	constructor(platform: Platform, opts: SessionOptions) {
		this.#platform = platform;
		this.#opts = opts;
		this.#dht = new DhtClient(platform, { log: opts.log });
	}

	get(infoHash: string): TorrentSession | undefined {
		return this.#sessions.get(infoHash.toLowerCase());
	}

	/** Start an engine for the request (announcing immediately), or return the running one. */
	getOrCreate(request: TorrentRequest): TorrentSession {
		const key = request.infoHash.toHex();
		const existing = this.#sessions.get(key);
		if (existing) return existing;
		const engine = new TorrentEngine(this.#platform, { log: this.#opts.log, maxPeers: this.#opts.maxPeers, dht: this.#dht });
		const announce = [...new Set([...request.announce, ...this.#opts.defaultTrackers])];
		const ready = engine.prepare({ ...request, announce });
		ready.catch((err) => {
			this.#opts.log(`torrent ${key.slice(0, 8)} failed: ${err instanceof Error ? err.message : err}`);
			this.stop(key);
		});
		const session = { engine, ready };
		this.#sessions.set(key, session);
		return session;
	}

	/** The core's create call: hash + trackers, no file choice yet. */
	createFromHash(infoHash: string, announce: string[]): void {
		this.getOrCreate({ infoHash: InfoHash.fromHex(infoHash), announce, fileIdx: null });
	}

	/** Statistics in the shape stremio-core's StreamingServer model deserializes. */
	statistics(infoHash: string, fileIdx: number): TorrentStatistics | null {
		const engine = this.get(infoHash)?.engine;
		if (!engine?.info) return null;
		const info = engine.info;
		const files = info.files.map((f) => ({ name: f.path[f.path.length - 1] ?? '', path: f.path.join('/'), length: f.length, offset: f.offset }));
		const file = files[fileIdx] ?? files.reduce((a, b) => (b.length > a.length ? b : a));
		const s = engine.stats();
		return {
			name: info.name,
			infoHash: infoHash.toLowerCase(),
			files,
			sources: [],
			opts: {
				connections: this.#opts.maxPeers,
				dht: true,
				growler: { flood: 0, pulse: null },
				handshakeTimeout: 20000,
				path: file.path,
				peerSearch: { max: 200, min: 40, sources: [`dht:${infoHash}`] },
				swarmCap: { maxSpeed: null, minPeers: null },
				timeout: 8000,
				tracker: true,
				virtual: true,
			},
			downloadSpeed: s.downloadSpeed,
			uploadSpeed: 0,
			downloaded: s.downloadedBytes,
			uploaded: 0,
			unchoked: s.peers,
			peers: s.peers,
			queued: 0,
			unique: s.peers,
			connectionTries: 0,
			peerSearchRunning: false,
			streamLen: file.length,
			streamName: file.name,
			streamProgress: s.totalPieces ? s.completedPieces / s.totalPieces : 0,
			swarmConnections: s.peers,
			swarmPaused: false,
			swarmSize: s.peers,
		};
	}

	stop(infoHash: string): void {
		const key = infoHash.toLowerCase();
		this.#sessions.get(key)?.engine.stop();
		this.#sessions.delete(key);
	}

	stopAll(): void {
		for (const key of [...this.#sessions.keys()]) this.stop(key);
		this.#dht.stop();
	}
}
