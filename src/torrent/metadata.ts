/**
 * Metadata (info dict) exchange over the ut_metadata extension (BEP 9). For a
 * magnet link we start with only the info hash; peers serve the info dict in
 * 16 KiB pieces, which we assemble and verify against the hash before parsing.
 */
import { asDict, asInt, decodeFirst } from './bencode';
import { METADATA_PIECE_SIZE } from './constants';
import { parseInfoDict } from './metainfo';
import { InfoHash, type TorrentInfo } from './types';
import type { Platform } from '../platform/types';

const MSG_TYPE_DATA = 1;
const MSG_TYPE_REJECT = 2;

export class MetadataDownload {
	readonly numPieces: number;
	#buffer: Uint8Array;
	#have: boolean[];
	#size: number;

	constructor(metadataSize: number) {
		if (metadataSize <= 0 || metadataSize > 8 * 1024 * 1024) throw new Error(`bad metadata_size: ${metadataSize}`);
		this.#size = metadataSize;
		this.numPieces = Math.ceil(metadataSize / METADATA_PIECE_SIZE);
		this.#buffer = new Uint8Array(metadataSize);
		this.#have = new Array(this.numPieces).fill(false);
	}

	/** Piece indices still needed. */
	missing(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.numPieces; i++) if (!this.#have[i]) out.push(i);
		return out;
	}

	isComplete(): boolean {
		return this.#have.every(Boolean);
	}

	/**
	 * Handle a raw ut_metadata message (bencode dict + trailing data). Returns
	 * true if it delivered a new piece. Reject messages are ignored.
	 */
	onMessage(payload: Uint8Array): boolean {
		const { value, length } = decodeFirst(payload);
		const dict = asDict(value);
		const msgType = asInt(dict.get('msg_type'));
		if (msgType === MSG_TYPE_REJECT) return false;
		if (msgType !== MSG_TYPE_DATA) return false;
		const piece = asInt(dict.get('piece'));
		if (piece < 0 || piece >= this.numPieces || this.#have[piece]) return false;
		const data = payload.subarray(length);
		const offset = piece * METADATA_PIECE_SIZE;
		const expected = Math.min(METADATA_PIECE_SIZE, this.#size - offset);
		if (data.length < expected) return false;
		this.#buffer.set(data.subarray(0, expected), offset);
		this.#have[piece] = true;
		return true;
	}

	/** Verify the assembled bytes against `infoHash` and parse the info dict. */
	async finish(infoHash: InfoHash, platform: Platform): Promise<TorrentInfo> {
		if (!this.isComplete()) throw new Error('metadata incomplete');
		const hash = new InfoHash(await platform.sha1(this.#buffer));
		if (!hash.equals(infoHash)) throw new Error('metadata hash mismatch');
		return parseInfoDict(asDict(decodeFirst(this.#buffer).value), infoHash);
	}
}
