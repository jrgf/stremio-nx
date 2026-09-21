import { $ } from './$';
import { resolveDns } from './switch/dns';
import { EventTarget } from './polyfills/event-target';
import { SocketEvent, type SocketAddress, type SocketInfo } from './switch';
import {
	assertInternalConstructor,
	bufferSourceToArrayBuffer,
	createInternal,
	proto,
	toPromise,
} from './utils';
import type { BufferSource } from './types';
import {
	INTERNAL_SYMBOL,
	Opaque,
	type SocketOptionsInternal,
} from './internal';

export type TlsContextOpaque = Opaque<'TlsContext'>;

export function parseAddress(address: string): SocketAddress {
	const firstColon = address.indexOf(':');
	return {
		hostname: address.slice(0, firstColon),
		port: +address.slice(firstColon + 1),
	};
}

/**
 * Resolve and connect. `onPending` receives the in-flight attempt's fd so the
 * caller can abort it (with `$.close(fd)`) before it settles.
 */
export async function connect(opts: SocketAddress, onPending?: (fd: number) => void) {
	const { hostname = '127.0.0.1', port } = opts;
	const [ip] = await resolveDns(hostname);
	if (!ip) {
		throw new Error(`Could not resolve "${hostname}" to an IP address`);
	}
	return new Promise<number>((resolve, reject) => {
		const pending = $.connect((err, fd) => {
			// Native owns and closes failed attempts. Forget the pending fd before
			// rejecting, so Socket.close() cannot close a reused descriptor.
			onPending?.(-1);
			if (err) reject(err);
			else resolve(fd);
		}, ip, port);
		if (pending >= 0) onPending?.(pending);
	});
}

function read(fd: number, buffer: BufferSource) {
	const ab = bufferSourceToArrayBuffer(buffer);
	return toPromise($.read, fd, ab);
}

// The native write issues a single `send()` and reports how many bytes the
// socket accepted, so keep writing until the whole chunk is on the wire.
async function write(fd: number, data: BufferSource) {
	const ab = bufferSourceToArrayBuffer(data);
	let offset = 0;
	while (offset < ab.byteLength) {
		const n = await toPromise(
			$.write,
			fd,
			offset === 0 ? ab : new Uint8Array(ab, offset),
		);
		if (n <= 0) throw new Error('socket write made no progress');
		offset += n;
	}
}

function tlsHandshake(
	fd: number,
	hostname: string,
	rejectUnauthorized: boolean,
) {
	return toPromise($.tlsHandshake, fd, hostname, rejectUnauthorized);
}

function tlsRead(ctx: TlsContextOpaque, buffer: BufferSource) {
	const ab = bufferSourceToArrayBuffer(buffer);
	return toPromise($.tlsRead, ctx, ab);
}

function tlsWrite(ctx: TlsContextOpaque, data: BufferSource) {
	const ab = bufferSourceToArrayBuffer(data);
	return toPromise($.tlsWrite, ctx, ab);
}

interface SocketInternal {
	fd: number;
	tlsFd?: number; // fd transferred to the native TLS context (it owns/closes it)
	pendingFd?: number; // fd of a connect still in flight (abortable via close())
	tls?: TlsContextOpaque;
	opened: PromiseWithResolvers<SocketInfo>;
	closed: PromiseWithResolvers<void>;
	// Large per-socket read scratch buffer; released eagerly when the socket
	// finishes/closes (see the readable stream) to avoid exhausting the native
	// ArrayBuffer pool across many sockets.
	readBuffer?: ArrayBuffer;
	// Guard so close() runs once (it re-enters via readable.cancel()).
	closing?: boolean;
}

const _ = createInternal<Socket, SocketInternal>();

/**
 * The `Socket` class represents a TCP connection, from which you can
 * read and write data. A socket begins in a _connected_ state (if the
 * socket fails to connect, an error is thrown). While in a _connected_
 * state, the socket’s `ReadableStream` and `WritableStream` can be
 * read from and written to respectively.
 */
export class Socket {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	readonly opened: Promise<SocketInfo>;
	readonly closed: Promise<void>;

	/**
	 * @ignore
	 */
	constructor() {
		const address: SocketAddress = arguments[1];
		const {
			secureTransport = 'off',
			allowHalfOpen = false,
			rejectUnauthorized = true,
			connect,
		}: SocketOptionsInternal = arguments[2] || {};
		assertInternalConstructor(arguments);
		const socket = this;
		const i: SocketInternal = {
			fd: -1,
			opened: Promise.withResolvers(),
			closed: Promise.withResolvers(),
		};
		_.set(this, i);
		this.opened = i.opened.promise;
		this.closed = i.closed.promise;

		// Per-socket read scratch buffer. It is large (matches the native
		// `tcp_rx_buf_size` in `main.c`), and on Switch these ArrayBuffers are
		// backed by a limited native pool, so we MUST release it promptly when
		// the socket is done reading rather than waiting for GC — otherwise
		// opening many sockets (e.g. a long test run or redirect chains)
		// exhausts the pool with `RangeError: Array buffer allocation failed`.
		this.readable = new ReadableStream({
			async pull(controller) {
				await socket.opened;
				if (!i.readBuffer) {
					// Size to the native bsdsocket tcp_rx_buf_size configured
					// for this memory regime (1 MiB application / 128 KiB
					// applet), so applet mode does not over-allocate the
					// limited ArrayBuffer pool. Fall back to 1 MiB if unset.
					i.readBuffer = new ArrayBuffer($.tcpRxBufSize || 1024 * 1024);
				}
				let bytesRead: number;
				try {
					bytesRead = await (i.tls
						? tlsRead(i.tls, i.readBuffer)
						: read(i.fd, i.readBuffer));
				} catch (err) {
					// On a read error (e.g. ECONNRESET) the stream errors; free
					// the large read buffer back to the native pool rather than
					// holding it referenced until GC. Re-throw to preserve the
					// existing error-propagation behavior.
					i.readBuffer = undefined;
					throw err;
				}
				if (bytesRead === 0) {
					i.readBuffer = undefined; // EOF: free the buffer
					controller.close();
					if (!allowHalfOpen) {
						socket.close();
					}
					return;
				}
				controller.enqueue(
					new Uint8Array(i.readBuffer.slice(0, bytesRead)),
				);
			},
			// When a downstream consumer is done with the body (e.g. fetch's
			// Content-Length transform calls terminate() after the declared
			// number of bytes), the pipe cancels this source. Close the socket
			// so the underlying connection (and any in-flight read poll) is torn
			// down — otherwise a keep-alive server never sends EOF and the
			// pending read would hang forever.
			cancel() {
				i.readBuffer = undefined; // free the buffer
				socket.close();
			},
		});

		this.writable = new WritableStream({
			async write(chunk) {
				await socket.opened;
				await (i.tls ? tlsWrite(i.tls, chunk) : write(i.fd, chunk));
			},
			close() {
				socket.close();
			},
		});

		connect(address, (fd) => {
			i.pendingFd = fd >= 0 ? fd : undefined;
			if (i.closing && fd >= 0) {
				$.close(fd);
				i.pendingFd = undefined;
			}
		})
			.then((fd) => {
				i.pendingFd = undefined;
				if (i.closing) {
					// close() ran while the connect was still in flight: the fd
					// arrives now and nobody else will ever close it.
					$.close(fd);
					throw new Error('socket closed before connecting');
				}
				i.fd = fd;
				if (secureTransport === 'on') {
					// Once we hand the fd to the TLS layer, the native TLS
					// context OWNS the fd (and a uv_poll_t on it). The fd must
					// then be closed only via `$.tlsClose` — never `$.close` —
					// otherwise closing it out from under the poll corrupts the
					// bsdsocket sysmodule. Mark our fd as transferred.
					i.tlsFd = fd;
					i.fd = -1;
					return tlsHandshake(fd, address.hostname, rejectUnauthorized);
				}
			})
			.then((tls) => {
				i.tls = tls;
				i.opened.resolve({
					localAddress: '',
					remoteAddress: '',
				});
			})
			.catch((err) => {
				this.close(err);
			});
	}

	/**
	 * Closes the socket and its underlying connection.
	 */
	close(reason?: any) {
		const i = _(this);
		// Idempotent: close() re-enters itself via readable.cancel()'s handler
		// (which calls socket.close()), so guard against running twice. Without
		// this, the re-entrant call would reject `opened` with its (undefined)
		// reason BEFORE the original reason, masking the real error (e.g. a TLS
		// handshake failure surfaced as a bare `undefined` rejection).
		if (i.closing) return this.closed;
		i.closing = true;
		// Reject `opened` with the real reason FIRST, before cancelling the
		// readable (whose cancel handler re-enters close()).
		i.readBuffer = undefined; // release the large read buffer promptly
		if (typeof i.pendingFd === 'number') {
			// Abort a connect still in flight: drops the pending op and closes
			// the fd once libuv lets go of it, releasing its socket buffers now
			// instead of at the TCP stack's own (long) connect timeout.
			$.close(i.pendingFd);
			i.pendingFd = undefined;
		}
		i.opened.reject(reason);
		// cancel()/abort() on a stream that already errored (e.g. a read that
		// failed with ECONNRESET) reject with the stored error; nothing awaits
		// them here, so swallow the rejection or it surfaces as fatal.
		if (!this.readable.locked) {
			this.readable.cancel(reason).catch(() => {});
		}
		if (!this.writable.locked) {
			this.writable.abort(reason).catch(() => {});
		}
		if (i.tls) {
			// TLS context owns its fd; tear it down natively (closes the
			// uv_poll_t then the fd). Never $.close the fd directly.
			$.tlsClose(i.tls);
			i.tls = undefined;
			i.tlsFd = undefined;
		} else if (typeof i.tlsFd === 'number') {
			// Handshake was attempted but never produced a TLS context handle
			// (e.g. it failed). The native TLS context already owns + tears
			// down this fd on failure, so do NOT $.close it here.
			i.tlsFd = undefined;
		} else if (i.fd !== -1) {
			$.close(i.fd);
		}
		i.fd = -1;
		i.closed.resolve();
		return this.closed;
	}

	/**
	 * Enables opportunistic TLS (otherwise known as
	 * {@link https://en.wikipedia.org/wiki/Opportunistic_TLS | StartTLS})
	 * which is a requirement for some protocols
	 * (primarily postgres/mysql and other DB protocols).
	 */
	startTls(): Socket {
		throw new Error('Method not implemented.');
	}
}

export class Server extends EventTarget {
	/**
	 * @ignore
	 */
	constructor() {
		assertInternalConstructor(arguments);
		super();
	}

	/**
	 * The "accept" event is fired when a new TCP client connection
	 * has been established. Use the `fd` property to determine
	 * which file descriptor to read / write to interact with this
	 * socket.
	 */
	// @ts-expect-error Not sure why this is error :(
	addEventListener(
		type: 'accept',
		listener: (ev: SocketEvent) => any,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		super.addEventListener(type, callback, options);
	}

	/**
	 * Shuts down the server and closes any existing client connections.
	 */
	close() {}
}
$.tcpServerInit(Server);

export function createServer(ip: string, port: number) {
	const server = $.tcpServerNew(ip, port, function onAccept(fd) {
		// @ts-expect-error Internal constructor
		const socket = new Socket(INTERNAL_SYMBOL, null, {
			allowHalfOpen: true,
			async connect() {
				return fd;
			},
		});
		server.dispatchEvent(new SocketEvent('accept', { socket }));
	});
	return proto(server, Server);
}
