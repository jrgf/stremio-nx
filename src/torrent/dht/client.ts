/**
 * Minimal DHT client (BEP 5) for peer discovery: an iterative `get_peers`
 * lookup from well-known bootstrap routers, walking toward the info hash and
 * collecting the peers nodes hand back. We announce as read-only (BEP 43),
 * keep no routing table of our own, and remember the nodes that answered so
 * a later lookup starts closer. That is all a streaming leecher needs: it
 * finds peers for one torrent at a time, without trackers.
 */
import type { Platform, UdpSocket } from '../../platform/types';
import type { Bencode, BencodeDict } from '../bencode';
import { parseCompactPeers, dedupePeers } from '../tracker/peers';
import type { PeerAddr } from '../types';
import { compareDistance, decodeMessage, encodeQuery, parseCompactNodes, type DhtNode } from './krpc';

export const DEFAULT_BOOTSTRAP = [
	'router.bittorrent.com:6881',
	'dht.transmissionbt.com:6881',
	'router.utorrent.com:6881',
	'dht.libtorrent.org:25401',
];

export interface DhtOptions {
	bootstrap?: string[];
	log?: (msg: string) => void;
	/** Parallel queries per lookup. */
	alpha?: number;
	queryTimeoutMs?: number;
}

export interface LookupOptions {
	/** Stop once this many distinct peers were reported. */
	maxPeers?: number;
	timeoutMs?: number;
	maxQueries?: number;
}

export interface LookupResult {
	peers: number;
	queried: number;
	responded: number;
}

const K = 8;

interface Candidate extends PeerAddr {
	id?: Uint8Array;
	queried: boolean;
}

interface Pending {
	resolve: (r: BencodeDict) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class DhtClient {
	#platform: Platform;
	#opts: Required<DhtOptions>;
	#nodeId: Uint8Array;
	#socket?: UdpSocket;
	#pending = new Map<string, Pending>();
	#running = false;
	/** Nodes that answered a previous lookup; seeds the next one. */
	#goodNodes: DhtNode[] = [];

	constructor(platform: Platform, opts: DhtOptions = {}) {
		this.#platform = platform;
		this.#nodeId = platform.randomBytes(20);
		this.#opts = {
			bootstrap: opts.bootstrap ?? DEFAULT_BOOTSTRAP,
			log: opts.log ?? (() => {}),
			alpha: opts.alpha ?? 6,
			queryTimeoutMs: opts.queryTimeoutMs ?? 2500,
		};
	}

	/** Iterative get_peers for `infoHash`; `onPeers` fires as nodes hand peers back. */
	async getPeers(infoHash: Uint8Array, onPeers: (peers: PeerAddr[]) => void, opts: LookupOptions = {}): Promise<LookupResult> {
		await this.#ensureSocket();
		const maxPeers = opts.maxPeers ?? 100;
		const maxQueries = opts.maxQueries ?? 300;
		const deadline = this.#platform.now() + (opts.timeoutMs ?? 25000);

		const candidates = new Map<string, Candidate>();
		const add = (n: PeerAddr & { id?: Uint8Array }) => {
			const key = `${n.ip}:${n.port}`;
			if (!candidates.has(key)) candidates.set(key, { ...n, queried: false });
		};
		for (const n of this.#goodNodes) add(n);
		for (const n of await this.#resolveBootstrap()) add(n);

		const responded: DhtNode[] = [];
		const seen = new Set<string>();
		let queried = 0;
		let peersFound = 0;

		const kthDistanceBound = (): Uint8Array | undefined => {
			if (responded.length < K) return undefined;
			responded.sort((a, b) => compareDistance(a.id, b.id, infoHash));
			return responded[K - 1].id;
		};
		const next = (): Candidate | undefined => {
			const bound = kthDistanceBound();
			let best: Candidate | undefined;
			for (const c of candidates.values()) {
				if (c.queried) continue;
				// Unknown-id candidates (bootstrap routers) always go first.
				if (!c.id) return c;
				if (bound && compareDistance(c.id, bound, infoHash) >= 0) continue;
				if (!best || !best.id || compareDistance(c.id, best.id, infoHash) < 0) best = c;
			}
			return best;
		};
		const done = () => peersFound >= maxPeers || queried >= maxQueries || this.#platform.now() > deadline;

		const worker = async () => {
			for (;;) {
				if (done()) return;
				const c = next();
				if (!c) return;
				c.queried = true;
				queried++;
				let r: BencodeDict;
				try {
					r = await this.#query(c, 'get_peers', new Map<string, Bencode>([['id', this.#nodeId], ['info_hash', infoHash]]));
				} catch {
					continue;
				}
				const id = r.get('id');
				if (id instanceof Uint8Array && id.length === 20) responded.push({ id, ip: c.ip, port: c.port });
				const values = r.get('values');
				if (Array.isArray(values)) {
					const fresh = dedupePeers(values.flatMap((v) => (v instanceof Uint8Array ? parseCompactPeers(v) : []))).filter((p) => {
						const key = `${p.ip}:${p.port}`;
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					});
					if (fresh.length) {
						peersFound += fresh.length;
						onPeers(fresh);
					}
				}
				const nodes = r.get('nodes');
				if (nodes instanceof Uint8Array) for (const n of parseCompactNodes(nodes)) add(n);
			}
		};
		await Promise.all(Array.from({ length: this.#opts.alpha }, worker));

		// Remember the closest responders for the next lookup.
		responded.sort((a, b) => compareDistance(a.id, b.id, infoHash));
		this.#goodNodes = responded.slice(0, 32);
		const result = { peers: peersFound, queried, responded: responded.length };
		this.#opts.log(`dht: ${result.peers} peers from ${result.responded}/${result.queried} nodes`);
		return result;
	}

	stop(): void {
		this.#running = false;
		for (const p of this.#pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error('dht stopped'));
		}
		this.#pending.clear();
		this.#socket?.close();
		this.#socket = undefined;
	}

	async #ensureSocket(): Promise<void> {
		if (this.#socket) return;
		this.#socket = await this.#platform.udp();
		this.#running = true;
		void this.#receiveLoop(this.#socket);
	}

	async #resolveBootstrap(): Promise<PeerAddr[]> {
		const out: PeerAddr[] = [];
		await Promise.all(
			this.#opts.bootstrap.map(async (hostPort) => {
				const i = hostPort.lastIndexOf(':');
				try {
					out.push({ ip: await this.#platform.resolve(hostPort.slice(0, i)), port: Number(hostPort.slice(i + 1)) });
				} catch {
					// Unresolvable router; the others will do.
				}
			}),
		);
		return out;
	}

	async #query(to: PeerAddr, q: string, a: BencodeDict): Promise<BencodeDict> {
		const socket = this.#socket;
		if (!socket) throw new Error('dht not started');
		const t = this.#platform.randomBytes(2);
		const key = tidKey(t);
		const result = new Promise<BencodeDict>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(key);
				reject(new Error('dht query timed out'));
			}, this.#opts.queryTimeoutMs);
			this.#pending.set(key, { resolve, reject, timer });
		});
		await socket.send(encodeQuery(t, q, a), to.ip, to.port);
		return result;
	}

	async #receiveLoop(socket: UdpSocket): Promise<void> {
		while (this.#running && this.#socket === socket) {
			const dg = await socket.receive(1000);
			if (!dg) continue;
			let msg;
			try {
				msg = decodeMessage(dg.data);
			} catch {
				continue;
			}
			const pending = this.#pending.get(tidKey(msg.t));
			if (!pending) continue; // a query to us (we are read-only) or a stray reply
			this.#pending.delete(tidKey(msg.t));
			clearTimeout(pending.timer);
			if (msg.type === 'response') pending.resolve(msg.r);
			else if (msg.type === 'error') pending.reject(new Error(`dht error ${msg.code}: ${msg.message}`));
			else pending.reject(new Error('dht: query with our transaction id'));
		}
	}
}

function tidKey(t: Uint8Array): string {
	return Array.from(t, (b) => b.toString(16).padStart(2, '0')).join('');
}

