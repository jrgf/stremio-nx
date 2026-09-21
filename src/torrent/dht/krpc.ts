/**
 * KRPC (BEP 5) message codec: bencoded query/response/error dicts over UDP,
 * compact node info, and XOR distance for the Kademlia lookup.
 */
import { asBytes, asDict, asInt, asList, asString, encode, decode, type Bencode, type BencodeDict } from '../bencode';
import type { PeerAddr } from '../types';

export interface DhtNode extends PeerAddr {
	id: Uint8Array;
}

export type KrpcMessage =
	| { type: 'query'; t: Uint8Array; q: string; a: BencodeDict }
	| { type: 'response'; t: Uint8Array; r: BencodeDict }
	| { type: 'error'; t: Uint8Array; code: number; message: string };

const str = (s: string) => new TextEncoder().encode(s);

/** A query dict. `ro: 1` (BEP 43) says we are read-only: do not add us to routing tables. */
export function encodeQuery(t: Uint8Array, q: string, a: BencodeDict): Uint8Array {
	return encode(new Map<string, Bencode>([['t', t], ['y', str('q')], ['q', str(q)], ['a', a], ['ro', 1]]));
}

export function encodeResponse(t: Uint8Array, r: BencodeDict): Uint8Array {
	return encode(new Map<string, Bencode>([['t', t], ['y', str('r')], ['r', r]]));
}

export function decodeMessage(buf: Uint8Array): KrpcMessage {
	const dict = asDict(decode(buf));
	const t = asBytes(dict.get('t'));
	switch (asString(dict.get('y'))) {
		case 'q':
			return { type: 'query', t, q: asString(dict.get('q')), a: asDict(dict.get('a')) };
		case 'r':
			return { type: 'response', t, r: asDict(dict.get('r')) };
		case 'e': {
			const e = asList(dict.get('e'));
			return { type: 'error', t, code: asInt(e[0]), message: e[1] instanceof Uint8Array ? new TextDecoder().decode(e[1]) : '' };
		}
		default:
			throw new Error('krpc: unknown message type');
	}
}

/** Compact node info: 26 bytes each (20 id + 4 IPv4 + 2 port). */
export function parseCompactNodes(buf: Uint8Array): DhtNode[] {
	const nodes: DhtNode[] = [];
	for (let i = 0; i + 26 <= buf.length; i += 26) {
		const port = (buf[i + 24] << 8) | buf[i + 25];
		if (port === 0) continue;
		nodes.push({ id: buf.slice(i, i + 20), ip: `${buf[i + 20]}.${buf[i + 21]}.${buf[i + 22]}.${buf[i + 23]}`, port });
	}
	return nodes;
}

export function encodeCompactNodes(nodes: DhtNode[]): Uint8Array {
	const out = new Uint8Array(nodes.length * 26);
	nodes.forEach((n, i) => {
		out.set(n.id, i * 26);
		const ip = n.ip.split('.').map(Number);
		out.set(ip, i * 26 + 20);
		out[i * 26 + 24] = n.port >> 8;
		out[i * 26 + 25] = n.port & 0xff;
	});
	return out;
}

/** Compare XOR distances of `a` and `b` to `target`: negative if `a` is closer. */
export function compareDistance(a: Uint8Array, b: Uint8Array, target: Uint8Array): number {
	for (let i = 0; i < 20; i++) {
		const da = a[i] ^ target[i];
		const db = b[i] ^ target[i];
		if (da !== db) return da - db;
	}
	return 0;
}
