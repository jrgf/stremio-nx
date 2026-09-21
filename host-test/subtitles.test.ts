import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSubtitles, parseSubtitles, subtitleTextAt } from '../src/stremio/subtitles';
import type { Addon } from '../src/stremio/addons';

test('subtitle timing, overlaps, backward seeks and supported text formats', () => {
	const cues = parseSubtitles('\uFEFF1\r\n00:00:01,000 --> 00:00:04,000\r\n<i>First &amp; second</i>\r\n\r\n2\n00:00:02,000 --> 00:00:03,000\nOverlap');
	assert.equal(subtitleTextAt(cues, .5), '');
	assert.equal(subtitleTextAt(cues, 2.5), 'First & second\nOverlap');
	assert.equal(subtitleTextAt(cues, 4), '');
	assert.equal(subtitleTextAt(cues, 1), 'First & second');
	assert.equal(subtitleTextAt(cues, NaN), '');
	assert.equal(subtitleTextAt(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nHello'), 1.5), 'Hello');
	assert.equal(subtitleTextAt(parseSubtitles('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello\\NWorld'), 1.5), 'Hello\nWorld');
	assert.throws(() => parseSubtitles('<html>not subtitles</html>'), /No text subtitles/);
	assert.throws(() => parseSubtitles('1\n00:00:90,000 --> 00:00:95,000\nInvalid'), /No text subtitles/);
});

test('subtitle requests honor resource filters, configured paths, partial failure and cancellation', async () => {
	const addon: Addon = { transportUrl: 'https://example.com/config/manifest.json?token=private', manifest: { id: 'sub', name: 'Subs', version: '1.0.0', types: ['movie'], resources: ['subtitles'], catalogs: [] } };
	const original = globalThis.fetch, requests: string[] = [];
	globalThis.fetch = async input => {
		const url = String(input); requests.push(url);
		if (url.includes('broken')) return new Response('', { status: 503 });
		return new Response(JSON.stringify({ subtitles: [{ id: 'en', lang: 'eng', url: 'https://subs.example/en.srt' }, { id: 'bad', lang: 'eng', url: 'file:///private' }] }));
	};
	try {
		const result = await findSubtitles([addon, { ...addon, transportUrl: 'https://broken.example/manifest.json' }, { ...addon, manifest: { ...addon.manifest, resources: [{ name: 'subtitles', types: ['series'], idPrefixes: ['tt'] }] } }], 'movie', 'tt123:1:2', 'My Film.mkv', 1234);
		assert.equal(result.tracks.length, 1);
		assert.equal(result.failed, 1);
		assert.equal(requests.length, 2);
		assert.ok(requests[0].includes('/config/subtitles/movie/tt123%3A1%3A2/filename=My%20Film.mkv&videoSize=1234.json?token=private'));
		const abort = new AbortController(); abort.abort();
		assert.deepEqual(await findSubtitles([addon], 'movie', 'tt123', 'file', 1, abort.signal), { tracks: [], failed: 0 });
		assert.equal(requests.length, 2);
	} finally { globalThis.fetch = original; }
});
