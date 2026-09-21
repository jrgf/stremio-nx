import { createHash } from 'node:crypto';
import { InfoHash, type TorrentInfo } from '../src/torrent/types';

/** A single-file torrent of `numPieces` pieces (last one short) with real piece data and hashes. */
export function makeTorrent(numPieces: number, pieceLength: number, lastPieceLen: number) {
	const totalLength = (numPieces - 1) * pieceLength + lastPieceLen;
	const data = new Uint8Array(totalLength);
	for (let i = 0; i < totalLength; i++) data[i] = (i * 2654435761) & 0xff;
	const pieceHashes: Uint8Array[] = [];
	for (let i = 0; i < numPieces; i++) {
		const size = i < numPieces - 1 ? pieceLength : lastPieceLen;
		pieceHashes.push(new Uint8Array(createHash('sha1').update(data.subarray(i * pieceLength, i * pieceLength + size)).digest()));
	}
	const info: TorrentInfo = {
		infoHash: InfoHash.fromHex('00'.repeat(20)),
		name: 't',
		pieceLength,
		pieceHashes,
		files: [{ path: ['t'], length: totalLength, offset: 0 }],
		totalLength,
	};
	return { info, data };
}
