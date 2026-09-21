/**
 * Piece download state, verification, and a read-head-priority block picker.
 * Works in global byte space (across the whole torrent); the engine translates
 * the chosen file's offsets to and from this space. Completed pieces are cached
 * in memory for the player to read and evicted behind the read head to bound
 * memory.
 */
import { BLOCK_SIZE } from './constants';
import type { TorrentInfo } from './types';
import type { Platform } from '../platform/types';

export interface BlockRequest {
	index: number;
	begin: number;
	length: number;
}

export type BlockResult = 'completed' | 'partial' | 'failed' | 'ignored';

const INFLIGHT_TIMEOUT_MS = 8000;
/** Max peers to race the same block within the critical (read-head) window. */
const MAX_DUP_CRITICAL = 3;

interface Partial {
	buf: Uint8Array;
	received: boolean[];
	count: number;
}

interface Inflight {
	count: number;
	time: number;
}

export class PieceManager {
	readonly numPieces: number;
	readonly pieceLength: number;
	readonly totalLength: number;

	#hashes: Uint8Array[];
	#platform: Platform;
	#complete: boolean[];
	#cache = new Map<number, Uint8Array>();
	#partial = new Map<number, Partial>();
	#inflight = new Map<string, Inflight>();
	#readHead = 0;
	#keepFrom = 0;
	#keepTo = Number.POSITIVE_INFINITY;

	constructor(info: TorrentInfo, platform: Platform) {
		this.numPieces = info.pieceHashes.length;
		this.pieceLength = info.pieceLength;
		this.totalLength = info.totalLength;
		this.#hashes = info.pieceHashes;
		this.#platform = platform;
		this.#complete = new Array(this.numPieces).fill(false);
	}

	pieceSize(index: number): number {
		if (index < this.numPieces - 1) return this.pieceLength;
		return this.totalLength - (this.numPieces - 1) * this.pieceLength;
	}

	blockCount(index: number): number {
		return Math.ceil(this.pieceSize(index) / BLOCK_SIZE);
	}

	hasPiece(index: number): boolean {
		return this.#complete[index];
	}

	setReadHead(globalOffset: number): void {
		this.#readHead = Math.max(0, Math.min(globalOffset, this.totalLength - 1));
		const index = Math.floor(this.#readHead / this.pieceLength);
		if (index < this.#keepFrom || index >= this.#keepTo) {
			this.#keepFrom = 0;
			this.#keepTo = this.numPieces;
		}
	}

	/** [min, max] completed piece index, or null if none. */
	completedRange(): [number, number] | null {
		let min = -1;
		let max = -1;
		for (let i = 0; i < this.numPieces; i++) {
			if (this.#complete[i]) {
				if (min === -1) min = i;
				max = i;
			}
		}
		return min === -1 ? null : [min, max];
	}

	progress(): { completed: number; total: number } {
		let completed = 0;
		for (const c of this.#complete) if (c) completed++;
		return { completed, total: this.numPieces };
	}

	/**
	 * Next blocks to request from a peer, read-head first. A block already in
	 * flight is skipped, except within the critical window (the first
	 * `criticalPieces` pieces from the read head), where up to
	 * `MAX_DUP_CRITICAL` peers may race the same block so playback start is not
	 * held hostage to one slow peer. In-flight requests older than the timeout
	 * are eligible again.
	 */
	pickRequests(
		peerHas: (index: number) => boolean,
		max: number,
		now: number,
		criticalPieces = 0,
		windowPieces = Number.POSITIVE_INFINITY,
	): BlockRequest[] {
		const out: BlockRequest[] = [];
		const head = Math.floor(this.#readHead / this.pieceLength);
		for (const index of this.#pieceOrder(windowPieces)) {
			if (out.length >= max) break;
			if (this.#complete[index] || !peerHas(index)) continue;
			const critical = index >= head && index < head + criticalPieces;
			const allowed = critical ? MAX_DUP_CRITICAL : 1;
			const partial = this.#partial.get(index);
			const blocks = this.blockCount(index);
			for (let b = 0; b < blocks && out.length < max; b++) {
				if (partial?.received[b]) continue;
				const begin = b * BLOCK_SIZE;
				const key = `${index}:${begin}`;
				const entry = this.#inflight.get(key);
				const outstanding = entry && now - entry.time < INFLIGHT_TIMEOUT_MS ? entry.count : 0;
				if (outstanding >= allowed) continue;
				const length = Math.min(BLOCK_SIZE, this.pieceSize(index) - begin);
				this.#inflight.set(key, { count: outstanding + 1, time: now });
				out.push({ index, begin, length });
			}
		}
		return out;
	}

	/** Store a received block; verify and cache the piece once all blocks arrive. */
	async onBlock(index: number, begin: number, block: Uint8Array): Promise<BlockResult> {
		const entry = this.#inflight.get(`${index}:${begin}`);
		if (entry && --entry.count <= 0) this.#inflight.delete(`${index}:${begin}`);
		if (!Number.isInteger(index) || index < this.#keepFrom || index >= Math.min(this.#keepTo, this.numPieces) || this.#complete[index]) return 'ignored';
		if (!Number.isInteger(begin) || begin < 0 || begin % BLOCK_SIZE !== 0) return 'ignored';
		const blockIdx = begin / BLOCK_SIZE;
		const blocks = this.blockCount(index);
		if (blockIdx >= blocks) return 'ignored';
		const expected = Math.min(BLOCK_SIZE, this.pieceSize(index) - begin);
		if (block.length !== expected) return 'ignored';

		let partial = this.#partial.get(index);
		if (!partial) {
			partial = { buf: new Uint8Array(this.pieceSize(index)), received: new Array(blocks).fill(false), count: 0 };
			this.#partial.set(index, partial);
		}
		if (partial.received[blockIdx]) return 'partial';
		partial.buf.set(block.subarray(0, expected), begin);
		partial.received[blockIdx] = true;
		partial.count++;
		if (partial.count < blocks) return 'partial';

		// Piece full: verify against its SHA-1.
		const hash = await this.#platform.sha1(partial.buf);
		// A seek/stop may have evicted this allocation while hashing.
		if (this.#partial.get(index) !== partial) return 'ignored';
		this.#partial.delete(index);
		if (!hash.every((v, i) => v === this.#hashes[index][i])) return 'failed';
		this.#cache.set(index, partial.buf);
		this.#complete[index] = true;
		return 'completed';
	}

	/**
	 * Contiguous verified bytes available from `globalOffset`, up to `length`.
	 * A range inside one piece is returned as a view of the cached piece (no
	 * copy); wider ranges are assembled into a new buffer.
	 */
	read(globalOffset: number, length: number): Uint8Array {
		const end = Math.min(globalOffset + this.bufferedFrom(globalOffset), globalOffset + length, this.totalLength);
		if (globalOffset >= end) return new Uint8Array(0);
		const firstIndex = Math.floor(globalOffset / this.pieceLength);
		const firstPiece = this.#cache.get(firstIndex);
		if (firstPiece && end <= (firstIndex + 1) * this.pieceLength) {
			const within = globalOffset - firstIndex * this.pieceLength;
			return firstPiece.subarray(within, within + (end - globalOffset));
		}
		const out = new Uint8Array(end - globalOffset);
		let written = 0;
		let pos = globalOffset;
		while (pos < end) {
			const index = Math.floor(pos / this.pieceLength);
			const piece = this.#cache.get(index);
			if (!piece) break;
			const within = pos - index * this.pieceLength;
			const take = Math.min(piece.length - within, end - pos);
			out.set(piece.subarray(within, within + take), written);
			written += take;
			pos += take;
		}
		return out.subarray(0, written);
	}

	/** Bytes contiguously available from `globalOffset` forward. */
	bufferedFrom(globalOffset: number): number {
		let n = 0;
		let pos = globalOffset;
		while (pos < this.totalLength) {
			const index = Math.floor(pos / this.pieceLength);
			if (!this.#complete[index]) break;
			const within = pos - index * this.pieceLength;
			const take = this.pieceSize(index) - within;
			n += take;
			pos += take;
		}
		return n;
	}

	/**
	 * Drop cached pieces before `globalOffset` to free memory, and FORGET them
	 * (clear the completed flag) so they are re-downloaded if the read head
	 * returns to them. Without forgetting, an evicted piece stays "complete" but
	 * has no bytes, so a later read of it returns nothing forever.
	 */
	evictBefore(globalOffset: number): void {
		this.retainRange(globalOffset, this.totalLength);
	}

	/** Keep only pieces intersecting this byte window, including partial downloads. */
	retainRange(start: number, end: number): void {
		this.#keepFrom = Math.floor(start / this.pieceLength);
		this.#keepTo = Math.ceil(end / this.pieceLength);
		const outside = (index: number) => index < this.#keepFrom || index >= this.#keepTo;
		for (const index of this.#cache.keys()) {
			if (outside(index)) {
				this.#cache.delete(index);
				this.#complete[index] = false;
			}
		}
		for (const index of this.#partial.keys()) if (outside(index)) this.#partial.delete(index);
		for (const key of this.#inflight.keys()) if (outside(Number(key.split(':', 1)[0]))) this.#inflight.delete(key);
	}

	memoryUsage(): { cachedBytes: number; partialBytes: number } {
		let cachedBytes = 0, partialBytes = 0;
		for (const bytes of this.#cache.values()) cachedBytes += bytes.byteLength;
		for (const partial of this.#partial.values()) partialBytes += partial.buf.byteLength;
		return { cachedBytes, partialBytes };
	}

	/**
	 * Piece indices from the read head forward, capped to a request window.
	 * Streaming never needs pieces behind the head until a seek moves it back,
	 * so we don't wrap (that would re-download played/evicted pieces). The
	 * window keeps all peers' bandwidth concentrated at the frontier the
	 * decoder needs next; without it, requests spread far ahead and the
	 * contiguous buffer in front of the decoder starves.
	 */
	*#pieceOrder(windowPieces: number): Generator<number> {
		const head = Math.floor(this.#readHead / this.pieceLength);
		const end = Math.min(this.numPieces, head + windowPieces);
		for (let i = head; i < end; i++) yield i;
	}
}
