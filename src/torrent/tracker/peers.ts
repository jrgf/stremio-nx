/**
 * Parse the peer list from a tracker response. Trackers return peers either in
 * the compact form (6 bytes each: 4-byte IPv4 + 2-byte port, BEP 23) or as a
 * list of dicts (`ip`/`port`).
 */
import { asDict, asInt, asString, type Bencode } from '../bencode';
import type { PeerAddr } from '../types';

/** Compact peers: a byte string of 6-byte (ip, port) records. */
export function parseCompactPeers(buf: Uint8Array): PeerAddr[] {
	if (buf.length % 6 !== 0) throw new Error(`compact peers not a multiple of 6: ${buf.length}`);
	const peers: PeerAddr[] = [];
	for (let i = 0; i < buf.length; i += 6) {
		const ip = `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`;
		const port = (buf[i + 4] << 8) | buf[i + 5];
		peers.push({ ip, port });
	}
	return peers;
}

/** Peers as either compact bytes or a bencoded list of {ip, port} dicts. */
export function parsePeers(value: Bencode | undefined): PeerAddr[] {
	if (value === undefined) return [];
	if (value instanceof Uint8Array) return parseCompactPeers(value);
	if (Array.isArray(value)) {
		return value.map((entry) => {
			const d = asDict(entry);
			return { ip: asString(d.get('ip')), port: asInt(d.get('port')) };
		});
	}
	throw new Error('unrecognized peers field');
}

/** Dedupe peers by ip:port. */
export function dedupePeers(peers: PeerAddr[]): PeerAddr[] {
	const seen = new Set<string>();
	const out: PeerAddr[] = [];
	for (const p of peers) {
		const key = `${p.ip}:${p.port}`;
		if (!seen.has(key)) {
			seen.add(key);
			out.push(p);
		}
	}
	return out;
}
