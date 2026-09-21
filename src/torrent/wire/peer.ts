/**
 * A single peer connection: TCP handshake (BEP 3), the extension handshake
 * (BEP 10) to discover ut_metadata, and a message read loop that surfaces
 * blocks and metadata to the engine via callbacks.
 */
import { ByteReader } from '../../platform/stream';
import type { Connection, Platform } from '../../platform/types';
import { asDict, asInt, decode, encode, type Bencode } from '../bencode';
import { Bitfield } from '../bitfield';
import type { PeerAddr } from '../types';
import { decodeMessage, encodeHandshake, frame, messages, parseHandshake } from './messages';

const EXT_HANDSHAKE_ID = 0;
const OUR_UT_METADATA_ID = 1;
const MAX_MESSAGE = 1 << 20;
const CONNECT_TIMEOUT_MS = 8000;

export interface PeerCallbacks {
	onPiece?: (index: number, begin: number, block: Uint8Array) => void;
	onHave?: (index: number) => void;
	onBitfield?: (bitfield: Bitfield) => void;
	onUnchoke?: () => void;
	/** Raw ut_metadata message payload (bencode dict + trailing data). */
	onMetadata?: (payload: Uint8Array) => void;
	onExtendedHandshake?: () => void;
	onClose?: (reason: string) => void;
}

export class Peer {
	readonly addr: PeerAddr;
	peerChoking = true;
	bitfield?: Bitfield;
	utMetadataId?: number;
	metadataSize?: number;
	handshakeDone = false;
	/** Block requests sent but not yet answered (bounds the per-peer pipeline). */
	outstanding = 0;

	#conn: Connection;
	#writer: WritableStreamDefaultWriter<Uint8Array>;
	#reader: ByteReader;
	#infoHash: Uint8Array;
	#peerId: Uint8Array;
	#cb: PeerCallbacks;
	#closed = false;

	private constructor(conn: Connection, infoHash: Uint8Array, peerId: Uint8Array, addr: PeerAddr, cb: PeerCallbacks) {
		this.#conn = conn;
		this.#writer = conn.writable.getWriter();
		this.#reader = new ByteReader(conn.readable);
		this.#infoHash = infoHash;
		this.#peerId = peerId;
		this.addr = addr;
		this.#cb = cb;
	}

	/** Connect, exchange handshakes, verify the info hash, and start the read loop. */
	static async connect(
		platform: Platform,
		addr: PeerAddr,
		infoHash: Uint8Array,
		peerId: Uint8Array,
		cb: PeerCallbacks,
	): Promise<Peer> {
		const conn = await platform.connect(addr.ip, addr.port, CONNECT_TIMEOUT_MS);
		const peer = new Peer(conn, infoHash, peerId, addr, cb);
		try {
			await peer.#handshake();
		} catch (err) {
			await peer.close();
			throw err;
		}
		void peer.#run();
		return peer;
	}

	async #handshake(): Promise<void> {
		await this.#writer.write(encodeHandshake(this.#infoHash, this.#peerId));
		const raw = await withTimeout(this.#reader.readExact(68), CONNECT_TIMEOUT_MS, 'handshake');
		const hs = raw && parseHandshake(raw);
		if (!hs) throw new Error('bad handshake');
		if (!hs.infoHash.every((b, i) => b === this.#infoHash[i])) throw new Error('info hash mismatch');
		this.handshakeDone = true;
		if (hs.extensions) await this.#sendExtendedHandshake();
	}

	async #sendExtendedHandshake(): Promise<void> {
		const dict: Bencode = new Map<string, Bencode>([
			['m', new Map<string, Bencode>([['ut_metadata', OUR_UT_METADATA_ID]])],
		]);
		await this.send(messages.extended(EXT_HANDSHAKE_ID, encode(dict)));
	}

	async #run(): Promise<void> {
		try {
			for (;;) {
				const lenBuf = await this.#reader.readExact(4);
				if (!lenBuf) break;
				const len = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0);
				if (len === 0) continue; // keep-alive
				if (len > MAX_MESSAGE) throw new Error(`message too large: ${len}`);
				const body = await this.#reader.readExact(len);
				if (!body) break;
				this.#dispatch(body);
			}
		} catch (err) {
			this.#fail(err instanceof Error ? err.message : String(err));
			return;
		}
		this.#fail('closed');
	}

	#dispatch(body: Uint8Array): void {
		const msg = decodeMessage(body);
		switch (msg.type) {
			case 'choke':
				// A choking peer drops our queued requests (BEP 3).
				this.peerChoking = true;
				this.outstanding = 0;
				break;
			case 'unchoke': this.peerChoking = false; this.#cb.onUnchoke?.(); break;
			case 'have': this.bitfield?.set(msg.index); this.#cb.onHave?.(msg.index); break;
			case 'bitfield':
				this.bitfield = new Bitfield(msg.bits);
				this.#cb.onBitfield?.(this.bitfield);
				break;
			case 'piece':
				if (this.outstanding > 0) this.outstanding--;
				this.#cb.onPiece?.(msg.index, msg.begin, msg.block);
				break;
			case 'extended': this.#onExtended(msg.extId, msg.payload); break;
			default: break;
		}
	}

	#onExtended(extId: number, payload: Uint8Array): void {
		if (extId === EXT_HANDSHAKE_ID) {
			try {
				const dict = asDict(decode(payload));
				const m = dict.get('m');
				if (m instanceof Map && m.has('ut_metadata')) this.utMetadataId = asInt(m.get('ut_metadata'));
				if (dict.has('metadata_size')) this.metadataSize = asInt(dict.get('metadata_size'));
			} catch {
				// Ignore a malformed extended handshake.
			}
			this.#cb.onExtendedHandshake?.();
		} else if (extId === OUR_UT_METADATA_ID) {
			this.#cb.onMetadata?.(payload);
		}
	}

	async sendInterested(): Promise<void> {
		await this.send(messages.interested());
	}

	async sendKeepAlive(): Promise<void> {
		await this.send(keepAlive());
	}

	async sendCancel(index: number, begin: number, length: number): Promise<void> {
		await this.send(messages.cancel(index, begin, length));
	}

	async requestBlock(index: number, begin: number, length: number): Promise<void> {
		this.outstanding++;
		await this.send(messages.request(index, begin, length));
	}

	/** Request metadata piece `piece` (BEP 9) using the peer's ut_metadata id. */
	async requestMetadata(piece: number): Promise<void> {
		if (this.utMetadataId === undefined) throw new Error('peer has no ut_metadata');
		const req: Bencode = new Map<string, Bencode>([['msg_type', 0], ['piece', piece]]);
		await this.send(messages.extended(this.utMetadataId, encode(req)));
	}

	has(index: number): boolean {
		return this.bitfield?.has(index) ?? false;
	}

	async send(bytes: Uint8Array): Promise<void> {
		if (this.#closed) return;
		await this.#writer.write(bytes);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#reader.release();
		} catch {
			// reader may already be released
		}
		try {
			this.#writer.releaseLock();
		} catch {
			// writer may already be released
		}
		await this.#conn.close().catch(() => undefined);
	}

	#fail(reason: string): void {
		if (this.#closed) return;
		void this.close();
		this.#cb.onClose?.(reason);
	}
}

export function keepAlive(): Uint8Array {
	return frame(null);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
	]);
}
