/**
 * Core torrent types shared across the engine. An info hash is the SHA-1 of the
 * bencoded `info` dict; addon streams identify a torrent by it plus trackers.
 */

/** 20-byte BitTorrent info hash, with hex helpers. */
export class InfoHash {
	readonly bytes: Uint8Array;

	constructor(bytes: Uint8Array) {
		if (bytes.length !== 20) throw new Error(`info hash must be 20 bytes, got ${bytes.length}`);
		this.bytes = bytes;
	}

	static fromHex(hex: string): InfoHash {
		if (hex.length !== 40) throw new Error(`info hash hex must be 40 chars, got ${hex.length}`);
		const bytes = new Uint8Array(20);
		for (let i = 0; i < 20; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		if (bytes.some((b, i) => Number.isNaN(bytes[i]))) throw new Error(`bad info hash hex: ${hex}`);
		return new InfoHash(bytes);
	}

	toHex(): string {
		let s = '';
		for (const b of this.bytes) s += b.toString(16).padStart(2, '0');
		return s;
	}

	equals(other: InfoHash): boolean {
		return this.bytes.every((b, i) => b === other.bytes[i]);
	}
}

/** A file within a (possibly multi-file) torrent. */
export interface TorrentFile {
	/** Path components relative to the torrent root. */
	path: string[];
	length: number;
	/** Byte offset of this file within the concatenated piece space. */
	offset: number;
}

/** The parsed `info` dict: the piece layout the engine downloads and verifies. */
export interface TorrentInfo {
	infoHash: InfoHash;
	name: string;
	pieceLength: number;
	/** SHA-1 hash per piece, 20 bytes each. */
	pieceHashes: Uint8Array[];
	files: TorrentFile[];
	totalLength: number;
}

/** A peer address discovered from a tracker, magnet source, or PEX. */
export interface PeerAddr {
	ip: string;
	port: number;
}

/** What an addon stream gives us: an info hash, trackers, and a file to play. */
export interface TorrentRequest {
	infoHash: InfoHash;
	announce: string[];
	/** Index of the file to stream, or null to pick the largest. */
	fileIdx: number | null;
	displayName?: string;
}
