/**
 * HTTP(S) tracker announce (BEP 3 + compact peers BEP 23). Uses the global
 * `fetch` (present on both nx.js and Node). Binary query params (info_hash,
 * peer_id) are percent-encoded byte-by-byte, since URLSearchParams would
 * mangle them as UTF-8.
 */
import { asDict, asInt, asString, decode } from '../bencode';
import type { PeerAddr } from '../types';
import { parsePeers } from './peers';

export interface AnnounceResult {
	peers: PeerAddr[];
	intervalSeconds: number;
}

export interface AnnounceParams {
	infoHash: Uint8Array;
	peerId: Uint8Array;
	port: number;
	left: number;
	uploaded?: number;
	downloaded?: number;
	numWant?: number;
}

export async function announceHttp(baseUrl: string, params: AnnounceParams, timeoutMs = 15000): Promise<AnnounceResult> {
	const query = [
		`info_hash=${percentEncode(params.infoHash)}`,
		`peer_id=${percentEncode(params.peerId)}`,
		`port=${params.port}`,
		`uploaded=${params.uploaded ?? 0}`,
		`downloaded=${params.downloaded ?? 0}`,
		`left=${params.left}`,
		`compact=1`,
		`numwant=${params.numWant ?? 50}`,
	].join('&');
	const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${query}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let bytes: Uint8Array;
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) throw new Error(`tracker HTTP ${res.status}`);
		bytes = new Uint8Array(await res.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}

	const dict = asDict(decode(bytes));
	if (dict.has('failure reason')) throw new Error(`tracker: ${asString(dict.get('failure reason'))}`);
	return {
		peers: parsePeers(dict.get('peers')),
		intervalSeconds: dict.has('interval') ? asInt(dict.get('interval')) : 1800,
	};
}

/** Percent-encode raw bytes per RFC 1738, escaping everything but unreserved. */
export function percentEncode(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) {
		if (
			(b >= 0x30 && b <= 0x39) || // 0-9
			(b >= 0x41 && b <= 0x5a) || // A-Z
			(b >= 0x61 && b <= 0x7a) || // a-z
			b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e // - _ . ~
		) {
			out += String.fromCharCode(b);
		} else {
			out += `%${b.toString(16).padStart(2, '0').toUpperCase()}`;
		}
	}
	return out;
}
