/**
 * A minimal remote BitTorrent peer for host tests: completes the handshake,
 * advertises ut_metadata id 2, sends a 1-piece bitfield, unchokes on
 * interest, and answers block + metadata requests. `blockDelayMs` makes it a
 * slow seeder; `onMessage` observes everything the client sends.
 */
import { ByteReader } from '../src/platform/stream';
import type { Connection } from '../src/platform/types';
import { encode, type Bencode } from '../src/torrent/bencode';
import { decodeMessage, encodeHandshake, frame, messages, type PeerMessage } from '../src/torrent/wire/messages';

export interface MockPeerOptions {
	blockDelayMs?: number;
	onMessage?: (msg: PeerMessage) => void;
}

export async function runMockPeer(
	conn: Connection,
	infoHash: Uint8Array,
	block: Uint8Array,
	metadata: Uint8Array = new Uint8Array(0),
	opts: MockPeerOptions = {},
): Promise<void> {
	const reader = new ByteReader(conn.readable);
	const writer = conn.writable.getWriter();
	try {
		const hs = await reader.readExact(68);
		if (!hs) return;
		await writer.write(encodeHandshake(infoHash, new Uint8Array(20).fill(2)));
		await writer.write(frame(5, new Uint8Array([0x80]))); // bitfield: has piece 0
		const extHandshake: Bencode = new Map<string, Bencode>([
			['m', new Map<string, Bencode>([['ut_metadata', 2]])],
			['metadata_size', metadata.length],
		]);
		await writer.write(messages.extended(0, encode(extHandshake)));

		for (;;) {
			const lenBuf = await reader.readExact(4);
			if (!lenBuf) break;
			const len = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0);
			if (len === 0) continue;
			const body = await reader.readExact(len);
			if (!body) break;
			const msg = decodeMessage(body);
			opts.onMessage?.(msg);
			if (msg.type === 'interested') {
				await writer.write(messages.unchoke());
			} else if (msg.type === 'request') {
				const reply = frame(7, concat(u32(msg.index), u32(msg.begin), block));
				if (opts.blockDelayMs) setTimeout(() => void writer.write(reply).catch(() => {}), opts.blockDelayMs);
				else await writer.write(reply);
			} else if (msg.type === 'extended' && msg.extId === 2) {
				const dict: Bencode = new Map<string, Bencode>([['msg_type', 1], ['piece', 0], ['total_size', metadata.length]]);
				await writer.write(messages.extended(1, concat(encode(dict), metadata)));
			}
		}
	} catch {
		// The client hung up; nothing to clean beyond the socket.
	}
}

export function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
			setTimeout(tick, 5);
		};
		tick();
	});
}

export function u32(n: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n);
	return b;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
