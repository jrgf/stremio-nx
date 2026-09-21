import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({ stdin: { contents: "export { MediaPlayer } from './src/app/player'; export { HttpStream } from './src/app/http-stream'; export { bufferTargets } from './src/app/buffering';", resolveDir: root },
	outfile: root + 'host-test/dist/player-check-module.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22',
	plugins: [{ name: 'no-console-entrypoint', setup(b) {
		b.onResolve({ filter: /^\.\/main$/ }, args => args.importer.endsWith('/app/player.ts') ? { path: 'probes', namespace: 'test' } : undefined);
		b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const probes = new Proxy({}, { get: (target, key) => target[key] ?? 0 });' }));
	} }] });
const { MediaPlayer, HttpStream, bufferTargets } = await import(pathToFileURL(root + 'host-test/dist/player-check-module.mjs'));
const MiB = 1024 * 1024, length = 100 * MiB;
let source, video, active = 0, cancelled = 0, delay = 5, maximumStored = 0;
const ranges = [];
class Source {
	position = 0; wanted = 0; url = 'nx-media:test'; chunks = []; closed = false;
	constructor() { source = this; }
	get storedBytes() { return this.chunks.reduce((sum, c) => sum + c.end - c.start, 0); }
	provide(start, bytes) {
		assert.equal(this.closed, false, 'late response must not feed a closed source');
		const from = start + this.buffered(start);
		const next = this.chunks.filter(c => c.start >= from).sort((a,b) => a.start - b.start)[0];
		const end = Math.min(start + bytes.length, next?.start ?? Infinity);
		if (from < end) this.chunks.push({ start: from, end });
		if (this.wanted >= start && this.wanted < start + bytes.length) this.wanted = -1;
		maximumStored = Math.max(maximumStored, this.storedBytes);
	}
	retain(start, end, prefix = 0) { this.chunks = this.chunks.filter(c => c.start < prefix || (c.start < end && c.end > start)); }
	buffered(pos) { let end = pos; for (const c of this.chunks.toSorted((a, b) => a.start - b.start)) if (c.start <= end && c.end > end) end = c.end; return end - pos; }
	close() { this.closed = true; this.chunks = []; }
}
class Video {
	readyState = 4; ended = false; seeking = false;
	decoder = 'software';
	src = ''; paused = true; duration = 100; time = 0; selectedAudioTrack = 1; selectedSubtitleTrack = -1; trackError = '';
	audioTracks = [{ id: 1, language: 'en', codec: 'aac', supported: true }, { id: 2, language: 'es', codec: 'aac', supported: true }]; subtitleTracks = [];
	constructor() { video = this; }
	setRenderSize(width, height) { assert.equal(this.src, ''); assert.equal(width, 1280); assert.equal(height, 720); }
	getFrameStats() { return { width: 1280, height: 720, transferMs: 0, convertMs: 1 }; }
	addEventListener() {}
	async play() { this.paused = false; }
	pause() { this.paused = true; }
	get currentTime() { return this.time; }
	set currentTime(t) { this.time = t; source.position = Math.floor(t * MiB); source.wanted = source.buffered(source.position) ? -1 : source.position; }
	getVideoPlaybackQuality() { return { totalVideoFrames: 100, droppedVideoFrames: 0 }; }
	selectAudioTrack(id) { this.selectedAudioTrack = id; }
}
globalThis.Switch = { MediaSource: Source, memoryUsage: () => ({ usedHeapSize: 1, heapSizeLimit: 100 }) };
globalThis.Video = Video; globalThis.fonts = new Set();
globalThis.screen = { width: 1280, height: 720 };
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
	const [start, end] = new Headers(init.headers).get('range').slice(6).split('-').map(Number);
	ranges.push({ start, end });
	active++;
	const finish = () => { active--; clearTimeout(timer); init.signal.removeEventListener('abort', abort); };
	const abort = () => { cancelled++; finish(); reject(new DOMException('Cancelled', 'AbortError')); };
	const timer = setTimeout(() => { finish(); resolve(new Response(new Uint8Array(end - start + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${length}` } })); }, delay);
	init.signal.addEventListener('abort', abort, { once: true });
});
async function until(predicate) {
	const deadline = Date.now() + 4000;
	while (!predicate()) { assert.ok(Date.now() < deadline, 'player did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
assert.equal(bufferTargets(length, 100).startup, 12 * MiB);
assert.equal(bufferTargets(length, 100).ahead, 48 * MiB);
assert.equal(bufferTargets(length, 100, 2 * MiB).ahead, 64 * MiB);
assert.equal(bufferTargets(length, 100, 100 * MiB).startup, 16 * MiB);
assert.equal(bufferTargets(length, Infinity).startup, 6 * MiB);

class Torrent {
	enabled = true; reads = []; head = 0; retained = [];
	setReadHead(pos) { this.head = pos; }
	retainRange(start, end) { assert.equal(start, this.head); this.retained.push([start, end]); }
	read(start, count) { this.reads.push({ start, end: start + count - 1 }); return new Uint8Array(this.enabled ? count : 0); }
	stats() { return { peers: 1, dhtPeers: 1, completedPieces: 1, totalPieces: 100, connectAttempts: 1, connectFailures: 0 }; }
	memoryUsage() { return { cachedBytes: 0, partialBytes: 0 }; }
}
for (const transport of ['HTTP', 'torrent']) {
	ranges.length = 0; maximumStored = 0; delay = 5;
	const input = transport === 'HTTP' ? new HttpStream({ url: 'https://video.example/movie' }) : new Torrent();
	if (input instanceof HttpStream) await input.open();
	let started = false, failure, startedAhead = 0;
	const logs = [];
	const player = new MediaPlayer(input, { length, path: ['movie.mkv'] }, { log(line) { logs.push(line); }, onStarted() { startedAhead = source.buffered(source.position); started = true; }, onError(error) { failure = error; } });
	player.start();
	try {
		await until(() => started); assert.equal(player.video, video); assert.equal(player.paused, false);
		assert.ok(startedAhead >= 12 * MiB, 'startup uses the shared 12-second estimate');
		await until(() => source.buffered(0) >= 48 * MiB && active === 0);
		const filledRequests = ranges.length;
		for (let i = 0; i < 8; i++) { source.position += 64 * 1024; await new Promise(resolve => setTimeout(resolve, 65)); }
		assert.equal(ranges.length, filledRequests, 'full cache must not cause tiny HTTP top-ups');
		assert.equal(player.tracks('audio').length, 2); await player.selectTrack('audio', '2'); assert.equal(video.selectedAudioTrack, 2);
		player.togglePause(); assert.equal(video.paused, true); player.togglePause();

		// Network starvation: a small delivery cannot repeatedly restart playback.
		delay = 2000; if (input instanceof Torrent) input.enabled = false;
		player.seekTo(60);
		await until(() => player.playback().buffering && video.paused);
		assert.equal(video.paused, true); assert.equal(player.paused, false);
		source.provide(60 * MiB, new Uint8Array(2 * MiB));
		await new Promise(resolve => setTimeout(resolve, 120));
		assert.equal(video.paused, true); assert.equal(player.playback().buffering, true);
		player.togglePause(); // The user's pause must survive refill completion.
		source.provide(62 * MiB, new Uint8Array(10 * MiB));
		await until(() => logs.some(l => l.includes('buffer recovered:')));
		assert.equal(video.paused, true); assert.equal(player.paused, true);
		player.togglePause(); assert.equal(video.paused, false);

		player.seekTo(85);
		await until(() => player.playback().buffering && video.paused);
		delay = 5;
		if (input instanceof HttpStream) input.cancel(); else input.enabled = true;
		await until(() => !player.playback().buffering && !video.paused);
		assert.ok(source.buffered(85 * MiB) >= 12 * MiB);
		assert.ok(source.buffered(0) >= 12 * MiB, 'opening object survives distant seeks');
		player.seekTo(99); await until(() => !player.playback().buffering);
		assert.equal(video.paused, false, 'near EOF must not wait for an impossible resume threshold');
		const requests = input instanceof Torrent ? input.reads : ranges;
		const beforeBack = requests.length;
		player.seekTo(1);
		await new Promise(resolve => setTimeout(resolve, 160));
		assert.ok(requests.slice(beforeBack).every(r => r.start >= 12 * MiB), 'cached opening bytes must not be fetched again');
		assert.ok(maximumStored <= 91 * MiB, 'prefix plus sliding windows remain byte-bounded');
		delay = 200;
		player.seekTo(75);
		if (input instanceof HttpStream) await until(() => active > 0);
		player.stop(); await until(() => active === 0);
		assert.equal(source.closed, true); assert.equal(source.storedBytes, 0); assert.equal(video.src, ''); assert.equal(failure, undefined);
		console.log(`PASS: ${transport} shared startup/read-ahead, starvation pause, refill hysteresis, user pause, EOF, prefix reuse, bounded cache and teardown`);
	} finally { player.stop(); }
}
