import type { Stream } from './client';

export function httpUrl(input: string): URL {
	let url: URL;
	try { url = new URL(input); } catch { throw new Error('Invalid video URL.'); }
	if (input.length > 16384 || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
		throw new Error('This source needs an HTTP(S) video URL without embedded login details.');
	}
	return url;
}

export function streamKind(stream: Stream): 'torrent' | 'url' | 'external' | 'unsupported' {
	if (stream.infoHash) return 'torrent';
	try {
		if (stream.url) { httpUrl(stream.url); return 'url'; }
		if (stream.externalUrl) { httpUrl(stream.externalUrl); return 'external'; }
	} catch { /* Invalid add-on data stays disabled in the stream list. */ }
	return 'unsupported';
}
