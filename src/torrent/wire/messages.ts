/**
 * Peer wire message framing (BEP 3) + extension envelope (BEP 10). Pure
 * encode/decode over byte buffers; the socket read loop in peer.ts supplies
 * framed message bodies (length prefix already stripped).
 */
import { MessageId, PROTOCOL } from '../constants';

const encoder = new TextEncoder();

export interface Handshake {
	infoHash: Uint8Array;
	peerId: Uint8Array;
	extensions: boolean;
}

/** 68-byte handshake: pstrlen, pstr, reserved(8), info_hash(20), peer_id(20). */
export function encodeHandshake(infoHash: Uint8Array, peerId: Uint8Array): Uint8Array {
	const out = new Uint8Array(68);
	out[0] = 19;
	out.set(encoder.encode(PROTOCOL), 1);
	out[25] = 0x10; // reserved byte 5, bit 0x10 = extension protocol (BEP 10)
	out.set(infoHash, 28);
	out.set(peerId, 48);
	return out;
}

export function parseHandshake(buf: Uint8Array): Handshake | null {
	if (buf.length < 68 || buf[0] !== 19) return null;
	if (new TextDecoder().decode(buf.subarray(1, 20)) !== PROTOCOL) return null;
	return {
		extensions: (buf[25] & 0x10) !== 0,
		infoHash: buf.subarray(28, 48),
		peerId: buf.subarray(48, 68),
	};
}

/** Length-prefixed message: [len(4)][id(1)][payload]. Empty payload => keep-alive when id omitted. */
export function frame(id: number | null, payload?: Uint8Array): Uint8Array {
	if (id === null) return new Uint8Array(4); // keep-alive: length 0
	const body = payload ?? new Uint8Array(0);
	const out = new Uint8Array(5 + body.length);
	new DataView(out.buffer).setUint32(0, 1 + body.length);
	out[4] = id;
	out.set(body, 5);
	return out;
}

export const messages = {
	interested: () => frame(MessageId.Interested),
	notInterested: () => frame(MessageId.NotInterested),
	choke: () => frame(MessageId.Choke),
	unchoke: () => frame(MessageId.Unchoke),
	have: (index: number) => frame(MessageId.Have, u32(index)),
	request: (index: number, begin: number, length: number) => frame(MessageId.Request, u32x3(index, begin, length)),
	cancel: (index: number, begin: number, length: number) => frame(MessageId.Cancel, u32x3(index, begin, length)),
	extended: (extId: number, payload: Uint8Array) => {
		const body = new Uint8Array(1 + payload.length);
		body[0] = extId;
		body.set(payload, 1);
		return frame(MessageId.Extended, body);
	},
};

export type PeerMessage =
	| { type: 'keepAlive' }
	| { type: 'choke' }
	| { type: 'unchoke' }
	| { type: 'interested' }
	| { type: 'notInterested' }
	| { type: 'have'; index: number }
	| { type: 'bitfield'; bits: Uint8Array }
	| { type: 'request'; index: number; begin: number; length: number }
	| { type: 'piece'; index: number; begin: number; block: Uint8Array }
	| { type: 'cancel'; index: number; begin: number; length: number }
	| { type: 'extended'; extId: number; payload: Uint8Array }
	| { type: 'unknown'; id: number };

/** Decode a framed message body (id + payload, no length prefix). */
export function decodeMessage(body: Uint8Array): PeerMessage {
	if (body.length === 0) return { type: 'keepAlive' };
	const id = body[0];
	const p = body.subarray(1);
	const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
	switch (id) {
		case MessageId.Choke: return { type: 'choke' };
		case MessageId.Unchoke: return { type: 'unchoke' };
		case MessageId.Interested: return { type: 'interested' };
		case MessageId.NotInterested: return { type: 'notInterested' };
		case MessageId.Have: return { type: 'have', index: view.getUint32(0) };
		case MessageId.Bitfield: return { type: 'bitfield', bits: p.slice() };
		case MessageId.Request:
			return { type: 'request', index: view.getUint32(0), begin: view.getUint32(4), length: view.getUint32(8) };
		case MessageId.Piece:
			return { type: 'piece', index: view.getUint32(0), begin: view.getUint32(4), block: p.subarray(8) };
		case MessageId.Cancel:
			return { type: 'cancel', index: view.getUint32(0), begin: view.getUint32(4), length: view.getUint32(8) };
		case MessageId.Extended:
			return { type: 'extended', extId: p[0], payload: p.subarray(1) };
		default:
			return { type: 'unknown', id };
	}
}

function u32(n: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n);
	return b;
}

function u32x3(a: number, b: number, c: number): Uint8Array {
	const out = new Uint8Array(12);
	const v = new DataView(out.buffer);
	v.setUint32(0, a);
	v.setUint32(4, b);
	v.setUint32(8, c);
	return out;
}
