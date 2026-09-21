import type { Connection, Datagram, Platform, UdpSocket } from './types';

function wrap(socket: Switch.Socket): Connection {
	return {
		readable: socket.readable,
		writable: socket.writable,
		close: () => socket.close(),
	};
}

export const nxPlatform: Platform = {
	async connect(host, port, timeoutMs = 10000) {
		const socket = Switch.connect({ hostname: host, port });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('connect timed out')), timeoutMs);
		});
		try {
			await Promise.race([socket.opened, timeout]);
		} catch (err) {
			socket.close(); // also tears down a still-pending attempt
			throw err;
		} finally {
			clearTimeout(timer);
		}
		return wrap(socket);
	},

	listen(port, onAccept, ip) {
		const server = Switch.listen({ ip, port, accept: (e) => onAccept(wrap(e.socket)) });
		return { close: () => server.close() };
	},

	async udp() {
		// A small inbound queue drains datagrams that arrive between receive() calls.
		const queue: Datagram[] = [];
		let wake: (() => void) | undefined;
		const socket = Switch.listenDatagram({
			port: 0,
			message: (e) => {
				queue.push({ data: new Uint8Array(e.data), host: e.remoteAddress, port: e.remotePort });
				wake?.();
			},
		});
		return {
			async send(data, host, port) {
				await socket.send(data, host, port);
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
			close: () => socket.close(),
		} satisfies UdpSocket;
	},

	async resolve(host) {
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
		const addrs = await Switch.resolveDns(host);
		const ipv4 = addrs.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) ?? addrs[0];
		if (!ipv4) throw new Error(`no address for ${host}`);
		return ipv4;
	},

	async sha1(data) {
		return new Uint8Array(await crypto.subtle.digest('SHA-1', data));
	},

	randomBytes(n) {
		const out = new Uint8Array(n);
		crypto.getRandomValues(out);
		return out;
	},

	now: () => Date.now(),

	async fileSize(path) {
		const stats = await Switch.stat(path);
		if (!stats) throw new Error(`file not found: ${path}`);
		return stats.size;
	},

	async readFile(path, start, end) {
		if (end <= start) return new Uint8Array(0);
		// The runtime's `end` is exclusive (fs.cc: size = end - start), despite the docs.
		const buf = await Switch.readFile(path, { start, end });
		if (!buf) throw new Error(`read failed: ${path}`);
		return new Uint8Array(buf);
	},
};
