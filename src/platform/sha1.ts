/**
 * Pure JavaScript SHA-1, for runtimes where the native digest has a high
 * per-call latency. Torrent piece hashes are SHA-1.
 */

const K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

export function sha1(data: Uint8Array): Uint8Array {
	const padded = pad(data);
	const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
	const state = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
	const w = new Int32Array(80);
	for (let offset = 0; offset < padded.length; offset += 64) {
		compress(state, view, offset, w);
	}
	const out = new Uint8Array(20);
	const outView = new DataView(out.buffer);
	for (let i = 0; i < 5; i++) outView.setInt32(i * 4, state[i]);
	return out;
}

function pad(data: Uint8Array): Uint8Array {
	const padded = new Uint8Array((((data.length + 8) >> 6) << 6) + 64);
	padded.set(data);
	padded[data.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bits = data.length * 8;
	view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
	view.setUint32(padded.length - 4, bits >>> 0);
	return padded;
}

function compress(state: Int32Array, view: DataView, offset: number, w: Int32Array): void {
	for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
	for (let i = 16; i < 80; i++) {
		const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
		w[i] = (x << 1) | (x >>> 31);
	}
	let [a, b, c, d, e] = state;
	for (let i = 0; i < 80; i++) {
		const round = i / 20;
		const f = round < 1 ? (b & c) | (~b & d) : round < 2 ? b ^ c ^ d : round < 3 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
		const t = (((a << 5) | (a >>> 27)) + f + e + K[round | 0] + w[i]) | 0;
		e = d;
		d = c;
		c = (b << 30) | (b >>> 2);
		b = a;
		a = t;
	}
	state[0] = (state[0] + a) | 0;
	state[1] = (state[1] + b) | 0;
	state[2] = (state[2] + c) | 0;
	state[3] = (state[3] + d) | 0;
	state[4] = (state[4] + e) | 0;
}
