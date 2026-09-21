/**
 * Parse a magnet URI or a .torrent file into engine types. The info hash for a
 * .torrent is the SHA-1 of the raw `info` bytes; magnets carry it directly.
 */
import { asBytes, asDict, asInt, asList, asString, decode, rawSpan } from './bencode';
import { InfoHash, type TorrentFile, type TorrentInfo, type TorrentRequest } from './types';
import type { Platform } from '../platform/types';

/** Parse `magnet:?xt=urn:btih:<hash>&dn=<name>&tr=<tracker>...`. */
export function parseMagnet(uri: string): TorrentRequest {
	if (!uri.startsWith('magnet:?')) throw new Error('not a magnet URI');
	const params = new URLSearchParams(uri.slice('magnet:?'.length));
	const xt = params.getAll('xt').find((v) => v.startsWith('urn:btih:'));
	if (!xt) throw new Error('magnet has no urn:btih info hash');
	const raw = xt.slice('urn:btih:'.length);
	const infoHash = raw.length === 40 ? InfoHash.fromHex(raw.toLowerCase()) : InfoHash.fromHex(base32ToHex(raw));
	return {
		infoHash,
		announce: params.getAll('tr'),
		fileIdx: null,
		displayName: params.get('dn') ?? undefined,
	};
}

/** Parse the bytes of a .torrent file into a full `TorrentInfo`. */
export async function parseTorrentFile(buf: Uint8Array, platform: Platform): Promise<TorrentInfo> {
	const root = asDict(decode(buf));
	const span = rawSpan(root, 'info');
	if (!span) throw new Error('.torrent has no info dict');
	const infoBytes = buf.subarray(span[0], span[1]);
	const infoHash = new InfoHash(await platform.sha1(infoBytes));
	return parseInfoDict(asDict(root.get('info')), infoHash);
}

/** Build a `TorrentInfo` from an already-decoded `info` dict (BEP 9 metadata). */
export function parseInfoDict(info: ReturnType<typeof asDict>, infoHash: InfoHash): TorrentInfo {
	const name = asString(info.get('name'));
	const pieceLength = asInt(info.get('piece length'));
	const pieces = asBytes(info.get('pieces'));
	if (pieces.length % 20 !== 0) throw new Error('pieces field not a multiple of 20');
	const pieceHashes: Uint8Array[] = [];
	for (let i = 0; i < pieces.length; i += 20) pieceHashes.push(pieces.subarray(i, i + 20));

	const files: TorrentFile[] = [];
	let offset = 0;
	if (info.has('files')) {
		for (const entry of asList(info.get('files'))) {
			const f = asDict(entry);
			const length = asInt(f.get('length'));
			const path = asList(f.get('path')).map((p) => asString(p));
			files.push({ path: [name, ...path], length, offset });
			offset += length;
		}
	} else {
		const length = asInt(info.get('length'));
		files.push({ path: [name], length, offset: 0 });
		offset = length;
	}

	return { infoHash, name, pieceLength, pieceHashes, files, totalLength: offset };
}

/** Verify a torrent's piece layout is internally consistent. */
export function validateInfo(info: TorrentInfo): void {
	const expectedPieces = Math.ceil(info.totalLength / info.pieceLength);
	if (expectedPieces !== info.pieceHashes.length) {
		throw new Error(`piece count mismatch: ${info.pieceHashes.length} hashes for ${expectedPieces} pieces`);
	}
}

function base32ToHex(base32: string): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const c of base32.toUpperCase()) {
		const idx = alphabet.indexOf(c);
		if (idx === -1) throw new Error(`bad base32 char: ${c}`);
		bits += idx.toString(2).padStart(5, '0');
	}
	let hex = '';
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		hex += Number.parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
	}
	return hex;
}
