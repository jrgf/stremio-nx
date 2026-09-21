/**
 * Runtime-agnostic I/O surface used by the torrent engine, the local HTTP
 * server and the device bench. Implemented for nx.js in `nx.ts`; a Node
 * implementation backs the host tests.
 */

export interface Connection {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	close(): Promise<void>;
}

export interface Listener {
	close(): void;
}

export interface Datagram {
	data: Uint8Array;
	host: string;
	port: number;
}

/** Bound UDP socket, for UDP trackers (BEP 15) and later DHT. */
export interface UdpSocket {
	send(data: Uint8Array, host: string, port: number): Promise<void>;
	/** Next datagram, or null if none arrives within `timeoutMs`. */
	receive(timeoutMs: number): Promise<Datagram | null>;
	close(): void;
}

export interface Platform {
	/** Connects, or rejects after `timeoutMs` with the attempt torn down (no leaked socket). */
	connect(host: string, port: number, timeoutMs?: number): Promise<Connection>;
	listen(port: number, onAccept: (conn: Connection) => void, ip?: string): Listener;
	udp(): Promise<UdpSocket>;
	/** Resolve a hostname to an IPv4 address (returns IP literals unchanged). */
	resolve(host: string): Promise<string>;
	sha1(data: Uint8Array): Promise<Uint8Array>;
	randomBytes(n: number): Uint8Array;
	now(): number;
	fileSize(path: string): Promise<number>;
	/** Reads bytes in `[start, end)`. */
	readFile(path: string, start: number, end: number): Promise<Uint8Array>;
}
