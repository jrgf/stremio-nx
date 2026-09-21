/**
 * Torrent engine: turns a magnet/info-hash request into a byte-addressable
 * stream. It announces to trackers, connects peers, fetches metadata (BEP 9)
 * when starting from a magnet, then downloads pieces read-head first and
 * verifies them. The app drives playback by setting the read head and reading
 * bytes; the engine keeps the swarm busy on a timer.
 *
 * Pure data plane — no `Video`/`MediaSource` here, so it runs under Node tests.
 */
import { generatePeerId } from './constants';
import type { DhtClient } from './dht';
import { MetadataDownload } from './metadata';
import { PieceManager } from './pieces';
import { announceAll, type AnnounceParams } from './tracker';
import { InfoHash, type PeerAddr, type TorrentFile, type TorrentInfo, type TorrentRequest } from './types';
import { Peer } from './wire/peer';
import type { Platform } from '../platform/types';

export interface EngineOptions {
	maxPeers?: number;
	/** Max block requests kept in flight per peer. */
	pipelineDepth?: number;
	listenPort?: number;
	log?: (msg: string) => void;
	/** Preloaded info (from a .torrent) to skip the metadata phase. */
	info?: TorrentInfo;
	/** DHT client for trackerless peer discovery (owned by the caller). */
	dht?: DhtClient;
}

export interface EngineStats {
	peers: number;
	/** Peers discovered through the DHT so far. */
	dhtPeers: number;
	downloadedBytes: number;
	/** Bytes per second over the last few seconds. */
	downloadSpeed: number;
	/** Outbound connection attempts so far, and how many failed (timeout, refused, bad handshake). */
	connectAttempts: number;
	connectFailures: number;
	completedPieces: number;
	totalPieces: number;
	haveMetadata: boolean;
}

/** Pick the file to stream: the requested index, or the largest file. */
export function pickFile(info: TorrentInfo, fileIdx: number | null): TorrentFile {
	if (fileIdx !== null) {
		if (fileIdx < 0 || fileIdx >= info.files.length) throw new Error(`file index ${fileIdx} out of range`);
		return info.files[fileIdx];
	}
	return info.files.reduce((a, b) => (b.length > a.length ? b : a));
}

export class TorrentEngine {
	info?: TorrentInfo;
	file?: TorrentFile;

	#platform: Platform;
	#opts: Required<Omit<EngineOptions, 'info' | 'log' | 'dht'>> & { log: (m: string) => void };
	#dht?: DhtClient;
	#dhtPeers = 0;
	#connectAttempts = 0;
	#connectFailures = 0;
	#dhtBusy = false;
	#lastDht = 0;
	#peerId: Uint8Array;
	#request!: TorrentRequest;
	#peers = new Map<string, Peer>();
	#knownAddrs: PeerAddr[] = [];
	#connecting = new Set<string>();
	#pieces?: PieceManager;
	#metadata?: MetadataDownload;
	#metadataInfo?: TorrentInfo;
	#running = false;
	#timer?: ReturnType<typeof setInterval>;
	#downloadedBytes = 0;
	#rateSamples: { t: number; bytes: number }[] = [];
	#lastAnnounce = 0;
	#announceIntervalMs = 30 * 60 * 1000;
	#lastKeepAlive = 0;
	#keepAliveIntervalMs = 60 * 1000;
	#announcing = false;
	/** Peers holding an outstanding request for each block ("index:begin"). */
	#blockPeers = new Map<string, Set<Peer>>();

	constructor(platform: Platform, opts: EngineOptions = {}) {
		this.#platform = platform;
		this.#peerId = generatePeerId(platform);
		this.#opts = {
			maxPeers: opts.maxPeers ?? 30,
			pipelineDepth: opts.pipelineDepth ?? 16,
			listenPort: opts.listenPort ?? 6881,
			log: opts.log ?? (() => {}),
		};
		this.info = opts.info;
		this.#dht = opts.dht;
	}

	/** Announce, connect peers, and (for magnets) fetch metadata. Resolves once the info dict is known. */
	async prepare(request: TorrentRequest): Promise<{ info: TorrentInfo; file: TorrentFile }> {
		this.#request = request;
		this.#running = true;
		this.#lastKeepAlive = this.#platform.now();
		if (this.info) this.#onMetadataReady(this.info);

		this.#timer = setInterval(() => void this.#tick(), 200);
		// Progressive: peers are connected as each tracker answers, so a dead
		// tracker's ~18 s timeout no longer delays the start.
		void this.#announce();
		void this.#dhtLookup();

		const info = await this.#waitForInfo();
		this.file = pickFile(info, request.fileIdx);
		this.#opts.log(`file: ${this.file.path.join('/')} (${(this.file.length / 1048576).toFixed(1)} MiB)`);
		return { info, file: this.file };
	}

	/** Merge externally discovered peers (DHT, PEX, tests) and connect to them. */
	addPeers(addrs: PeerAddr[]): void {
		this.#mergeAddrs(addrs);
		this.#connectMore();
	}

	setReadHead(fileOffset: number): void {
		if (this.#pieces && this.file) this.#pieces.setReadHead(this.file.offset + fileOffset);
	}

	/**
	 * Verified bytes available in the chosen file at `fileOffset`, never past
	 * the end of the piece it starts in, so the result is a zero-copy view of
	 * the cached piece. Callers loop to read further.
	 */
	read(fileOffset: number, length: number): Uint8Array {
		if (!this.#pieces || !this.file) return new Uint8Array(0);
		const global = this.file.offset + fileOffset;
		const pieceEnd = (Math.floor(global / this.#pieces.pieceLength) + 1) * this.#pieces.pieceLength;
		const clamped = Math.min(length, this.file.length - fileOffset, pieceEnd - global);
		if (clamped <= 0) return new Uint8Array(0);
		return this.#pieces.read(global, clamped);
	}

	bufferedFrom(fileOffset: number): number {
		if (!this.#pieces || !this.file) return 0;
		const global = this.#pieces.bufferedFrom(this.file.offset + fileOffset);
		return Math.min(global, this.file.length - fileOffset);
	}

	/** Free cached pieces well behind the read head. */
	evictBefore(fileOffset: number): void {
		if (this.#pieces && this.file) this.#pieces.evictBefore(this.file.offset + fileOffset);
	}

	retainRange(start: number, end: number): void {
		if (!this.#pieces || !this.file) return;
		const from = this.file.offset + start, to = this.file.offset + end;
		this.#pieces.retainRange(from, to);
		for (const [key, holders] of this.#blockPeers) {
			const [index, begin] = key.split(':').map(Number);
			if ((index + 1) * this.#pieces.pieceLength <= from || index * this.#pieces.pieceLength >= to) {
				this.#blockPeers.delete(key);
				for (const peer of holders) {
					peer.outstanding = Math.max(0, peer.outstanding - 1);
					void peer.sendCancel(index, begin, Math.min(16384, this.#pieces.pieceSize(index) - begin)).catch(() => {});
				}
			}
		}
	}

	memoryUsage(): { cachedBytes: number; partialBytes: number } {
		return this.#pieces?.memoryUsage() ?? { cachedBytes: 0, partialBytes: 0 };
	}

	stats(): EngineStats {
		const p = this.#pieces?.progress();
		return {
			peers: this.#peers.size,
			dhtPeers: this.#dhtPeers,
			downloadedBytes: this.#downloadedBytes,
			downloadSpeed: this.#downloadSpeed(),
			connectAttempts: this.#connectAttempts,
			connectFailures: this.#connectFailures,
			completedPieces: p?.completed ?? 0,
			totalPieces: p?.total ?? 0,
			haveMetadata: !!this.info,
		};
	}

	/** Diagnostics: read-head piece + completed index range. */
	debug(fileOffset: number): Record<string, unknown> | null {
		if (!this.#pieces || !this.file) return null;
		const g = this.file.offset + fileOffset;
		const idx = Math.floor(g / this.#pieces.pieceLength);
		let peersWithHead = 0;
		let unchoked = 0;
		for (const p of this.#peers.values()) {
			if (p.has(idx)) peersWithHead++;
			if (!p.peerChoking) unchoked++;
		}
		return {
			headPiece: idx,
			headComplete: this.#pieces.hasPiece(idx),
			completedRange: this.#pieces.completedRange(),
			peersWithHead,
			unchoked,
			peers: this.#peers.size,
		};
	}

	stop(): void {
		this.#running = false;
		if (this.#timer) clearInterval(this.#timer);
		for (const peer of this.#peers.values()) void peer.close();
		this.#peers.clear();
		this.#pieces?.retainRange(0, 0);
		this.#pieces = undefined;
		this.#metadata = undefined;
		this.#blockPeers.clear();
		this.#knownAddrs = [];
	}

	// --- internals ---

	async #announce(): Promise<void> {
		if (this.#announcing) return;
		this.#announcing = true;
		this.#lastAnnounce = this.#platform.now();
		try {
			if (this.#request.announce.length === 0) return;
			const params: AnnounceParams = {
				infoHash: this.#request.infoHash.bytes,
				peerId: this.#peerId,
				port: this.#opts.listenPort,
				left: this.info?.totalLength ?? 0,
				numWant: 80,
			};
			const { peers, errors } = await announceAll(this.#request.announce, params, this.#platform, (found) =>
				this.addPeers(found),
			);
			this.#opts.log(`announce: ${peers.length} peers, ${errors.length} tracker errors`);
			for (const e of errors.slice(0, 6)) this.#opts.log(`  tracker: ${e}`);
		} finally {
			this.#announcing = false;
		}
	}

	async #dhtLookup(): Promise<void> {
		if (!this.#dht || this.#dhtBusy) return;
		this.#dhtBusy = true;
		this.#lastDht = this.#platform.now();
		try {
			await this.#dht.getPeers(this.#request.infoHash.bytes, (peers) => {
				this.#dhtPeers += peers.length;
				this.addPeers(peers);
			});
		} catch (err) {
			this.#opts.log(`dht lookup failed: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.#dhtBusy = false;
		}
	}

	#mergeAddrs(addrs: PeerAddr[]): void {
		const known = new Set(this.#knownAddrs.map((a) => `${a.ip}:${a.port}`));
		for (const a of addrs) if (!known.has(`${a.ip}:${a.port}`)) this.#knownAddrs.push(a);
	}

	#downloadSpeed(): number {
		const s = this.#rateSamples;
		if (s.length < 2) return 0;
		const first = s[0];
		const last = s[s.length - 1];
		const dt = (last.t - first.t) / 1000;
		return dt > 0 ? (last.bytes - first.bytes) / dt : 0;
	}

	async #tick(): Promise<void> {
		if (!this.#running) return;
		this.#connectMore();
		const now = this.#platform.now();
		this.#rateSamples.push({ t: now, bytes: this.#downloadedBytes });
		while (this.#rateSamples.length > 1 && now - this.#rateSamples[0].t > 3000) this.#rateSamples.shift();
		if (now - this.#lastAnnounce > this.#announceIntervalMs) void this.#announce();
		// Running dry (few peers, no addresses left to try): ask the trackers
		// again early rather than waiting out the regular interval.
		const LOW_PEERS = 5;
		if (this.#peers.size < LOW_PEERS && this.#knownAddrs.length === 0) {
			if (now - this.#lastAnnounce > 60 * 1000) void this.#announce();
			if (now - this.#lastDht > 60 * 1000) void this.#dhtLookup();
		}
		if (now - this.#lastKeepAlive > this.#keepAliveIntervalMs) {
			// Peers drop idle connections after ~2 min of silence, and steady-state
			// playback only requests a trickle, so keep them warm.
			this.#lastKeepAlive = now;
			for (const peer of this.#peers.values()) void peer.sendKeepAlive().catch(() => {});
		}
		if (!this.info) this.#driveMetadata();
		else this.#driveDownload();
	}

	#connectMore(): void {
		const MAX_CONNECTING = 8;
		const target = this.#opts.maxPeers;
		while (
			this.#peers.size + this.#connecting.size < target &&
			this.#connecting.size < MAX_CONNECTING &&
			this.#knownAddrs.length > 0
		) {
			const addr = this.#knownAddrs.shift()!;
			const key = `${addr.ip}:${addr.port}`;
			if (this.#peers.has(key) || this.#connecting.has(key)) continue;
			this.#connecting.add(key);
			void this.#connectPeer(addr, key);
		}
	}

	async #connectPeer(addr: PeerAddr, key: string): Promise<void> {
		this.#connectAttempts++;
		let self: Peer | undefined;
		try {
			const peer = await Peer.connect(this.#platform, addr, this.#request.infoHash.bytes, this.#peerId, {
				onUnchoke: () => {},
				onPiece: (index, begin, block) => void this.#onPiece(self, index, begin, block),
				onMetadata: (payload) => this.#onMetadataMessage(payload),
				onClose: () => {
					this.#peers.delete(key);
					if (self) this.#forgetPeer(self);
				},
			});
			self = peer;
			if (!this.#running) { await peer.close(); return; }
			await peer.sendInterested();
			if (!this.#running) { await peer.close(); return; }
			this.#peers.set(key, peer);
		} catch {
			await self?.close();
			this.#connectFailures++; // dropped: timed out, refused or a bad handshake
		} finally {
			this.#connecting.delete(key);
		}
	}

	#driveMetadata(): void {
		for (const peer of this.#peers.values()) {
			if (peer.metadataSize && !this.#metadata) this.#metadata = new MetadataDownload(peer.metadataSize);
			if (!this.#metadata || peer.utMetadataId === undefined) continue;
			for (const piece of this.#metadata.missing().slice(0, 2)) void peer.requestMetadata(piece).catch(() => {});
		}
	}

	#onMetadataMessage(payload: Uint8Array): void {
		if (!this.#metadata || this.info) return;
		try {
			this.#metadata.onMessage(payload);
			if (this.#metadata.isComplete()) {
				void this.#metadata.finish(this.#request.infoHash, this.#platform).then(
					(info) => this.#onMetadataReady(info),
					(err) => this.#opts.log(`metadata failed: ${err.message}`),
				);
			}
		} catch (err) {
			this.#opts.log(`metadata message error: ${err instanceof Error ? err.message : err}`);
		}
	}

	#onMetadataReady(info: TorrentInfo): void {
		// Guard on the piece manager, not `info`: with a preloaded info dict
		// (from a .torrent) `info` is already set before this runs.
		if (!this.#running || this.#pieces) return;
		this.info = info;
		this.#pieces = new PieceManager(info, this.#platform);
		this.#metadataInfo = info;
		this.#opts.log(`metadata ready: ${info.name}, ${info.pieceHashes.length} pieces`);
	}

	#driveDownload(): void {
		if (!this.#pieces) return;
		const now = this.#platform.now();
		// The first few pieces from the read head are "critical": several peers may
		// race their blocks so playback start isn't held up by one slow peer.
		const CRITICAL_WINDOW = 4;
		// Only request within this many bytes of the read head, so the whole
		// swarm's bandwidth lands at the frontier the decoder needs next instead
		// of scattering far ahead (which starves the contiguous buffer).
		const REQUEST_WINDOW_BYTES = 8 * 1024 * 1024;
		const windowPieces = Math.max(4, Math.ceil(REQUEST_WINDOW_BYTES / this.#pieces.pieceLength));
		for (const peer of this.#peers.values()) {
			if (peer.peerChoking) continue;
			// Keep a bounded pipeline per peer: top it up to the depth, never past it.
			// Otherwise every tick queues more blocks on every peer, and a slow peer
			// hoards frontier blocks for the whole in-flight timeout.
			const slots = this.#opts.pipelineDepth - peer.outstanding;
			if (slots <= 0) continue;
			const reqs = this.#pieces.pickRequests((i) => peer.has(i), slots, now, CRITICAL_WINDOW, windowPieces);
			for (const r of reqs) {
				const key = `${r.index}:${r.begin}`;
				let holders = this.#blockPeers.get(key);
				if (!holders) this.#blockPeers.set(key, (holders = new Set()));
				holders.add(peer);
				void peer.requestBlock(r.index, r.begin, r.length).catch(() => {});
			}
		}
	}

	async #onPiece(from: Peer | undefined, index: number, begin: number, block: Uint8Array): Promise<void> {
		const pieces = this.#pieces;
		if (!this.#running || !pieces) return;
		this.#cancelElsewhere(from, index, begin, block.length);
		const result = await pieces.onBlock(index, begin, block);
		if (result === 'completed' && this.#running && this.#pieces === pieces) this.#downloadedBytes += pieces.pieceSize(index);
	}

	/**
	 * A block raced across several peers (critical window, or a timed-out
	 * request re-issued elsewhere) has arrived: cancel it at the others so
	 * their bandwidth and pipeline slots go to blocks we still need.
	 */
	#cancelElsewhere(from: Peer | undefined, index: number, begin: number, length: number): void {
		const key = `${index}:${begin}`;
		const holders = this.#blockPeers.get(key);
		if (!holders) return;
		this.#blockPeers.delete(key);
		for (const other of holders) {
			if (other === from) continue;
			if (other.outstanding > 0) other.outstanding--;
			void other.sendCancel(index, begin, length).catch(() => {});
		}
	}

	#forgetPeer(peer: Peer): void {
		for (const [key, holders] of this.#blockPeers) {
			holders.delete(peer);
			if (holders.size === 0) this.#blockPeers.delete(key);
		}
	}

	async #waitForInfo(): Promise<TorrentInfo> {
		return new Promise((resolve, reject) => {
			const started = this.#platform.now();
			const check = () => {
				if (this.info) return resolve(this.info);
				if (!this.#running) return reject(new Error('engine stopped'));
				if (this.#platform.now() - started > 120000) return reject(new Error('metadata timed out'));
				setTimeout(check, 100);
			};
			check();
		});
	}
}
