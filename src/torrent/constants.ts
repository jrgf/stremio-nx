import type { Platform } from '../platform/types';

/** Block size for piece requests (16 KiB, the de-facto standard). */
export const BLOCK_SIZE = 16 * 1024;

/** Metadata piece size for BEP 9 (also 16 KiB). */
export const METADATA_PIECE_SIZE = 16 * 1024;

/** Peer wire message ids (BEP 3), plus the extended id (BEP 10). */
export const MessageId = {
	Choke: 0,
	Unchoke: 1,
	Interested: 2,
	NotInterested: 3,
	Have: 4,
	Bitfield: 5,
	Request: 6,
	Piece: 7,
	Cancel: 8,
	Extended: 20,
} as const;

export const PROTOCOL = 'BitTorrent protocol';

/** Client prefix for the 20-byte peer id (Azureus-style: `-NX0001-`). */
const PEER_ID_PREFIX = '-NX0001-';

/** Generate a 20-byte peer id: fixed client prefix + random tail. */
export function generatePeerId(platform: Platform): Uint8Array {
	const id = new Uint8Array(20);
	const prefix = new TextEncoder().encode(PEER_ID_PREFIX);
	id.set(prefix, 0);
	id.set(platform.randomBytes(20 - prefix.length), prefix.length);
	return id;
}
