/**
 * Announce to a list of trackers (http/https/udp) in parallel and return the
 * merged, deduped peer set. Failures on individual trackers are collected, not
 * fatal — swarms usually have several trackers and only some respond.
 *
 * `onPeers` fires per tracker as soon as it answers, so callers can start
 * connecting while slow or dead trackers are still timing out (a dead UDP
 * tracker takes ~18 s to give up).
 */
import type { Platform } from '../../platform/types';
import type { PeerAddr } from '../types';
import { announceHttp, type AnnounceParams } from './http';
import { announceUdp } from './udp';
import { dedupePeers } from './peers';

export interface TrackerScrape {
	peers: PeerAddr[];
	errors: string[];
}

export async function announceAll(
	trackers: string[],
	params: AnnounceParams,
	platform: Platform,
	onPeers?: (peers: PeerAddr[]) => void,
): Promise<TrackerScrape> {
	const results = await Promise.allSettled(
		trackers.map(async (url) => {
			const peers = await announceOne(url, params, platform);
			onPeers?.(peers);
			return peers;
		}),
	);
	const peers: PeerAddr[] = [];
	const errors: string[] = [];
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') peers.push(...r.value);
		else errors.push(`${trackers[i]}: ${r.reason?.message ?? r.reason}`);
	});
	return { peers: dedupePeers(peers), errors };
}

async function announceOne(url: string, params: AnnounceParams, platform: Platform): Promise<PeerAddr[]> {
	if (url.startsWith('udp://')) return (await announceUdp(url, params, platform)).peers;
	if (url.startsWith('http://') || url.startsWith('https://')) return (await announceHttp(url, params)).peers;
	throw new Error(`unsupported tracker scheme: ${url}`);
}

export type { AnnounceParams };
