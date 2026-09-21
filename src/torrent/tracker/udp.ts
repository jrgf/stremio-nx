/**
 * UDP tracker protocol (BEP 15). Two round-trips: connect (learn a
 * connection id) then announce (get peers). Each request retries with the
 * timeout schedule the spec suggests, scaled down for interactivity.
 */
import type { Platform, UdpSocket } from '../../platform/types';
import type { PeerAddr } from '../types';
import { parseCompactPeers } from './peers';
import type { AnnounceParams, AnnounceResult } from './http';

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;
const RETRIES = 3;

/** Parse `udp://host:port[/path]` into host + port. */
export function parseUdpUrl(url: string): { host: string; port: number } {
	const m = /^udp:\/\/([^:/]+):(\d+)/.exec(url);
	if (!m) throw new Error(`bad udp tracker url: ${url}`);
	return { host: m[1], port: Number(m[2]) };
}

export async function announceUdp(url: string, params: AnnounceParams, platform: Platform): Promise<AnnounceResult> {
	const { host, port } = parseUdpUrl(url);
	// nx.js UDP send needs an IP, not a hostname (Node's dgram resolves for us).
	const ip = await platform.resolve(host);
	const socket = await platform.udp();
	try {
		const connectionId = await connect(socket, ip, port, platform);
		return await announce(socket, ip, port, connectionId, params, platform);
	} finally {
		socket.close();
	}
}

async function connect(socket: UdpSocket, host: string, port: number, platform: Platform): Promise<Uint8Array> {
	const txId = platform.randomBytes(4);
	const req = new Uint8Array(16);
	const view = new DataView(req.buffer);
	view.setBigUint64(0, PROTOCOL_ID);
	view.setUint32(8, ACTION_CONNECT);
	req.set(txId, 12);

	const res = await roundTrip(socket, host, port, req, txId, 16);
	// [action(4)][txid(4)][connection_id(8)]
	return res.subarray(8, 16);
}

async function announce(
	socket: UdpSocket,
	host: string,
	port: number,
	connectionId: Uint8Array,
	params: AnnounceParams,
	platform: Platform,
): Promise<AnnounceResult> {
	const txId = platform.randomBytes(4);
	const req = new Uint8Array(98);
	const view = new DataView(req.buffer);
	req.set(connectionId, 0);
	view.setUint32(8, ACTION_ANNOUNCE);
	req.set(txId, 12);
	req.set(params.infoHash, 16);
	req.set(params.peerId, 36);
	view.setBigUint64(56, BigInt(params.downloaded ?? 0));
	view.setBigUint64(64, BigInt(params.left));
	view.setBigUint64(72, BigInt(params.uploaded ?? 0));
	view.setUint32(80, 0); // event: none
	view.setUint32(84, 0); // ip: default
	req.set(platform.randomBytes(4), 88); // key
	view.setInt32(92, params.numWant ?? 50);
	view.setUint16(96, params.port);

	const res = await roundTrip(socket, host, port, req, txId, 20);
	const resView = new DataView(res.buffer, res.byteOffset, res.byteLength);
	const interval = resView.getUint32(8);
	const peers = parseCompactPeers(res.subarray(20));
	return { peers, intervalSeconds: interval || 1800 };
}

/** Send `req`, await a response whose action is valid and txid matches, retrying. */
async function roundTrip(
	socket: UdpSocket,
	host: string,
	port: number,
	req: Uint8Array,
	txId: Uint8Array,
	minLen: number,
): Promise<Uint8Array> {
	let lastError = 'no response';
	for (let attempt = 0; attempt < RETRIES; attempt++) {
		await socket.send(req, host, port);
		const timeout = 3000 * (attempt + 1);
		const deadline = platform_now() + timeout;
		while (platform_now() < deadline) {
			const dg = await socket.receive(deadline - platform_now());
			if (!dg) break;
			if (dg.data.length < 8) continue;
			const view = new DataView(dg.data.buffer, dg.data.byteOffset, dg.data.byteLength);
			if (!txMatches(dg.data.subarray(4, 8), txId)) continue;
			const action = view.getUint32(0);
			if (action === ACTION_ERROR) {
				lastError = new TextDecoder().decode(dg.data.subarray(8));
				break;
			}
			if (dg.data.length >= minLen) return dg.data;
		}
	}
	throw new Error(`udp tracker: ${lastError}`);
}

function txMatches(a: Uint8Array, b: Uint8Array): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

// Standalone clock so roundTrip needn't thread `platform` everywhere.
let clock: () => number = () => Date.now();
function platform_now(): number {
	return clock();
}
export function setTrackerClock(fn: () => number): void {
	clock = fn;
}

export type { PeerAddr };
