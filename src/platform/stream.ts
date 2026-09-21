/**
 * Buffered reader over a `ReadableStream<Uint8Array>`: line and exact-length
 * reads, as needed by the HTTP parser and the peer wire protocol.
 */
export class ByteReader {
	#reader: ReadableStreamDefaultReader<Uint8Array>;
	#buf: Uint8Array = new Uint8Array(0);
	#eof = false;

	constructor(stream: ReadableStream<Uint8Array>) {
		this.#reader = stream.getReader();
	}

	/** Reads one line terminated by `\n` (a trailing `\r` is stripped). `null` at EOF. */
	async readLine(maxLength = 8192): Promise<string | null> {
		for (;;) {
			const nl = this.#buf.indexOf(0x0a);
			if (nl !== -1) {
				const end = nl > 0 && this.#buf[nl - 1] === 0x0d ? nl - 1 : nl;
				const line = new TextDecoder().decode(this.#buf.subarray(0, end));
				this.#buf = this.#buf.subarray(nl + 1);
				return line;
			}
			if (this.#buf.length > maxLength) throw new Error('line too long');
			if (!(await this.#fill())) return this.#buf.length ? this.#drain() : null;
		}
	}

	/** Reads exactly `n` bytes. `null` if the stream ends first. */
	async readExact(n: number): Promise<Uint8Array | null> {
		while (this.#buf.length < n) {
			if (!(await this.#fill())) return null;
		}
		const out = this.#buf.slice(0, n);
		this.#buf = this.#buf.subarray(n);
		return out;
	}

	/** Reads whatever is available, at least one byte. `null` at EOF. */
	async readSome(): Promise<Uint8Array | null> {
		if (this.#buf.length === 0 && !(await this.#fill())) return null;
		const out = this.#buf;
		this.#buf = new Uint8Array(0);
		return out;
	}

	release(): void {
		this.#reader.releaseLock();
	}

	#drain(): string {
		const line = new TextDecoder().decode(this.#buf);
		this.#buf = new Uint8Array(0);
		return line;
	}

	async #fill(): Promise<boolean> {
		if (this.#eof) return false;
		const { value, done } = await this.#reader.read();
		if (done || !value) {
			this.#eof = true;
			return false;
		}
		this.#buf = concat(this.#buf, value);
		return true;
	}
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	if (a.length === 0) return b;
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
