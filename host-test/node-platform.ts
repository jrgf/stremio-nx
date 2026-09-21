/** Node implementation of the platform interface, for host tests. */
import dgram from 'node:dgram';
import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import net from 'node:net';
import { Duplex } from 'node:stream';
import type { Connection, Datagram, Platform, UdpSocket } from '../src/platform/types';

function wrap(socket: net.Socket): Connection {
	const { readable, writable } = Duplex.toWeb(socket) as unknown as {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	};
	return {
		readable,
		writable,
		close: () => new Promise((resolve) => socket.end(() => resolve())),
	};
}

export const nodePlatform: Platform = {
	connect(host, port, timeoutMs = 10000) {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection({ host, port }, () => {
				socket.setTimeout(0);
				resolve(wrap(socket));
			});
			socket.setTimeout(timeoutMs, () => {
				socket.destroy(new Error('connect timed out'));
			});
			socket.once('error', reject);
		});
	},

	listen(port, onAccept, ip = '0.0.0.0') {
		const server = net.createServer((socket) => onAccept(wrap(socket)));
		server.listen(port, ip);
		return { close: () => void server.close() };
	},

	async udp() {
		const sock = dgram.createSocket('udp4');
		const queue: Datagram[] = [];
		let wake: (() => void) | undefined;
		sock.on('message', (msg, rinfo) => {
			queue.push({ data: new Uint8Array(msg), host: rinfo.address, port: rinfo.port });
			wake?.();
		});
		await new Promise<void>((resolve) => sock.bind(0, resolve));
		return {
			send(data, host, port) {
				return new Promise((resolve, reject) =>
					sock.send(data, port, host, (err) => (err ? reject(err) : resolve())),
				);
			},
			async receive(timeoutMs) {
				if (queue.length) return queue.shift()!;
				return new Promise<Datagram | null>((resolve) => {
					const timer = setTimeout(() => {
						wake = undefined;
						resolve(null);
					}, timeoutMs);
					wake = () => {
						clearTimeout(timer);
						wake = undefined;
						resolve(queue.shift() ?? null);
					};
				});
			},
			close: () => sock.close(),
		} satisfies UdpSocket;
	},

	async resolve(host) {
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
		const { address } = await promisify(dnsLookupCb)(host, { family: 4 });
		return address;
	},

	async sha1(data) {
		return new Uint8Array(createHash('sha1').update(data).digest());
	},

	randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),

	now: () => Date.now(),

	async fileSize(path) {
		return (await stat(path)).size;
	},

	async readFile(path, start, end) {
		const handle = await open(path, 'r');
		try {
			const buf = new Uint8Array(end - start);
			const { bytesRead } = await handle.read(buf, 0, buf.length, start);
			return buf.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
};
