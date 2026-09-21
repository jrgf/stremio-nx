/** A bitfield of piece availability (BEP 3): bit 0 is the most-significant bit of byte 0. */
export class Bitfield {
	readonly bytes: Uint8Array;

	constructor(sizeOrBytes: number | Uint8Array) {
		this.bytes = typeof sizeOrBytes === 'number' ? new Uint8Array(Math.ceil(sizeOrBytes / 8)) : sizeOrBytes;
	}

	has(index: number): boolean {
		const byte = index >> 3;
		if (byte >= this.bytes.length) return false;
		return (this.bytes[byte] & (0x80 >> (index & 7))) !== 0;
	}

	set(index: number): void {
		const byte = index >> 3;
		if (byte < this.bytes.length) this.bytes[byte] |= 0x80 >> (index & 7);
	}

	/** Count of set bits (pieces available). */
	count(): number {
		let n = 0;
		for (const b of this.bytes) {
			let v = b;
			while (v) {
				v &= v - 1;
				n++;
			}
		}
		return n;
	}
}
