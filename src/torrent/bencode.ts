/**
 * Bencode decode/encode (BEP 3). Byte strings decode to `Uint8Array` (info
 * dicts and piece hashes are binary); dictionaries to `Map<string, Bencode>`
 * with keys as UTF-8. `decodeInfoHashSpan` recovers the exact raw bytes of the
 * `info` value so the info hash is computed over the original encoding, not a
 * re-encode.
 */

export type Bencode = number | Uint8Array | Bencode[] | BencodeDict;
export type BencodeDict = Map<string, Bencode>;

const COLON = 0x3a;
const E = 0x65; // 'e'
const I = 0x69; // 'i'
const L = 0x6c; // 'l'
const D = 0x64; // 'd'
const ZERO = 0x30;
const NINE = 0x39;
const MINUS = 0x2d;

class Decoder {
	pos = 0;
	constructor(readonly buf: Uint8Array) {}

	decode(): Bencode {
		const b = this.buf[this.pos];
		if (b === I) return this.#int();
		if (b === L) return this.#list();
		if (b === D) return this.#dict();
		if (b >= ZERO && b <= NINE) return this.#bytes();
		throw new Error(`bencode: unexpected byte 0x${b?.toString(16)} at ${this.pos}`);
	}

	#int(): number {
		this.pos++; // 'i'
		const end = this.buf.indexOf(E, this.pos);
		if (end === -1) throw new Error('bencode: unterminated integer');
		const n = Number(this.#ascii(this.pos, end));
		if (!Number.isFinite(n)) throw new Error('bencode: bad integer');
		this.pos = end + 1;
		return n;
	}

	#bytes(): Uint8Array {
		const colon = this.buf.indexOf(COLON, this.pos);
		if (colon === -1) throw new Error('bencode: bad byte string length');
		const len = Number(this.#ascii(this.pos, colon));
		if (!Number.isInteger(len) || len < 0) throw new Error('bencode: bad byte string length');
		const start = colon + 1;
		this.pos = start + len;
		if (this.pos > this.buf.length) throw new Error('bencode: byte string past end');
		return this.buf.subarray(start, this.pos);
	}

	#list(): Bencode[] {
		this.pos++; // 'l'
		const out: Bencode[] = [];
		while (this.buf[this.pos] !== E) {
			if (this.pos >= this.buf.length) throw new Error('bencode: unterminated list');
			out.push(this.decode());
		}
		this.pos++; // 'e'
		return out;
	}

	#dict(): BencodeDict {
		this.pos++; // 'd'
		const out: BencodeDict = new Map();
		while (this.buf[this.pos] !== E) {
			if (this.pos >= this.buf.length) throw new Error('bencode: unterminated dict');
			const key = new TextDecoder().decode(this.#bytes());
			const valueStart = this.pos;
			const value = this.decode();
			out.set(key, value);
			spans.set(out, (spans.get(out) ?? new Map()).set(key, [valueStart, this.pos]));
		}
		this.pos++; // 'e'
		return out;
	}

	#ascii(start: number, end: number): string {
		let s = '';
		for (let i = start; i < end; i++) {
			const c = this.buf[i];
			if ((c < ZERO || c > NINE) && c !== MINUS) throw new Error('bencode: non-numeric');
			s += String.fromCharCode(c);
		}
		return s;
	}
}

// Raw [start, end) byte span of each value in a decoded dict, for exact re-hash.
const spans = new WeakMap<BencodeDict, Map<string, [number, number]>>();

export function decode(buf: Uint8Array): Bencode {
	return new Decoder(buf).decode();
}

/** Decode the first value and report how many bytes it consumed (BEP 9 payloads
 * are a bencode dict immediately followed by raw data). */
export function decodeFirst(buf: Uint8Array): { value: Bencode; length: number } {
	const d = new Decoder(buf);
	const value = d.decode();
	return { value, length: d.pos };
}

/** The raw bytes of `key`'s value within a dict decoded from `buf`. */
export function rawSpan(dict: BencodeDict, key: string): [number, number] | undefined {
	return spans.get(dict)?.get(key);
}

export function asDict(v: Bencode | undefined): BencodeDict {
	if (!(v instanceof Map)) throw new Error('bencode: expected dict');
	return v;
}

export function asBytes(v: Bencode | undefined): Uint8Array {
	if (!(v instanceof Uint8Array)) throw new Error('bencode: expected byte string');
	return v;
}

export function asString(v: Bencode | undefined): string {
	return new TextDecoder().decode(asBytes(v));
}

export function asInt(v: Bencode | undefined): number {
	if (typeof v !== 'number') throw new Error('bencode: expected integer');
	return v;
}

export function asList(v: Bencode | undefined): Bencode[] {
	if (!Array.isArray(v)) throw new Error('bencode: expected list');
	return v;
}

const encoder = new TextEncoder();

export function encode(value: Bencode): Uint8Array {
	const parts: Uint8Array[] = [];
	encodeInto(value, parts);
	return concatAll(parts);
}

function encodeInto(value: Bencode, parts: Uint8Array[]): void {
	if (typeof value === 'number') {
		if (!Number.isInteger(value)) throw new Error('bencode: only integers');
		parts.push(encoder.encode(`i${value}e`));
	} else if (value instanceof Uint8Array) {
		parts.push(encoder.encode(`${value.length}:`), value);
	} else if (Array.isArray(value)) {
		parts.push(encoder.encode('l'));
		for (const item of value) encodeInto(item, parts);
		parts.push(encoder.encode('e'));
	} else if (value instanceof Map) {
		parts.push(encoder.encode('d'));
		// Keys must be sorted by raw byte order (BEP 3).
		for (const key of [...value.keys()].sort()) {
			const keyBytes = encoder.encode(key);
			parts.push(encoder.encode(`${keyBytes.length}:`), keyBytes);
			encodeInto(value.get(key)!, parts);
		}
		parts.push(encoder.encode('e'));
	} else {
		throw new Error('bencode: unsupported value');
	}
}

function concatAll(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}
