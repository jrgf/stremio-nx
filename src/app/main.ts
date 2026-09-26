/**
 * stremio-nx: stremio-core decides what to play, our torrent engine plays it.
 * Boot: loopback control server (the core's streaming-server probes) ->
 * stremio-core -> the UI (rail, board, discover, library, search, details)
 * -> player (engine -> MediaSource -> Video) with an on-screen display.
 * Controller and touchscreen both drive the same model. Application mode only.
 */
import { nxPlatform } from '../platform/nx';
import { createControlHandler } from '../server/control';
import { createAddonHandler } from '../server/addons';
import { serveConnection } from '../server/http';
import { installShims, MemoryStore, type KeyValueStore } from '../shims';
import { StremioClient, torrentRequestFromStream } from '../stremio/client';
import { Input, type Button } from './input';
import { MediaPlayer } from './player';
import { HttpStream } from './http-stream';
import { httpUrl, streamKind } from '../stremio/streams';
import { ThumbnailCache } from './posters';
import { TorrentSessions } from './sessions';
import { attachTouch } from './touch';
import { UiModel, type UiServices } from './ui';
import { drawOsd, drawSubtitles, drawUi, hitTest, type HitRect } from './ui-draw';

const CONTROL_PORT = 11470;
const ADDON_PORT = 11471;
const CONTROL_BASE = `http://127.0.0.1:${CONTROL_PORT}/`;
const CONNECT_TIMEOUT_MS = 180_000;
const MiB = 1024 * 1024;

// Open UDP trackers added to every torrent (addon streams often carry none).
const DEFAULT_TRACKERS = [
	'udp://tracker.opentrackr.org:1337/announce',
	'udp://tracker.torrent.eu.org:451/announce',
	'udp://exodus.desync.com:6969/announce',
	'udp://explodie.org:6969/announce',
];

const BUTTONS: Button[] = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'minus'];
const FULL_MEMORY_APPLET_TYPES = new Set([0, 4]);

/** JS-thread timing probes from the render loop, read and reset by the stats line. */
export const probes = { renderMaxMs: 0, renderGapMs: 0, gapAtMs: 0, drawMaxMs: 0, logMaxMs: 0, diag: 0 };

// Log to the console canvas during boot and to the SD card always. The SD
// write is async and coalesced: a synchronous write stalled the JS thread,
// which also pumps video frames.
const LOG_DIR = 'sdmc:/switch/stremio-nx';
const LOG_PATH = `${LOG_DIR}/torrent-log.txt`;
/** Every flush rewrites the whole file, so periodic stats lines are batched. */
const LOG_FLUSH_MS = 5000;
const logLines: string[] = [];
let consoleHidden = false;
let logDirty = false;
let logFlushing = false;
let logTimer: ReturnType<typeof setTimeout> | undefined;
/** `lazy` lines (per-second stats) reach the SD card within LOG_FLUSH_MS; events and errors immediately. */
function log(msg: string, lazy = false): void {
	const start = performance.now();
	if (!consoleHidden) console.log(msg);
	logLines.push(msg);
	// Retain the launch header and the latest diagnostics, bounded for long sessions.
	if (logLines.length > 2048) logLines.splice(1, logLines.length - 2048);
	logDirty = true;
	if (!lazy) void flushLog();
	else if (!logTimer) logTimer = setTimeout(() => { logTimer = undefined; void flushLog(); }, LOG_FLUSH_MS);
	probes.logMaxMs = Math.max(probes.logMaxMs, performance.now() - start);
}
async function flushLog(): Promise<void> {
	if (logFlushing) return;
	logFlushing = true;
	try {
		while (logDirty) {
			logDirty = false;
			await Switch.writeFile(LOG_PATH, `${logLines.join('\n')}\n`);
		}
	} catch {
		// SD not writable; screen log still works.
	} finally {
		logFlushing = false;
	}
}

function pickStorage(): KeyValueStore {
	if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
	log('localStorage unavailable (no user profile?) - using in-memory store');
	return new MemoryStore();
}

/** The console's software keyboard as a promise; null when dismissed. */
function promptText(title: string, initial: string, onOpen: (open: boolean) => void): Promise<string | null> {
	return new Promise((resolve) => {
		const kb = navigator.virtualKeyboard as unknown as {
			value: string;
			okButtonText?: string;
			boundingRect: { height: number };
			show(): void;
			addEventListener(type: string, cb: () => void): void;
			removeEventListener(type: string, cb: () => void): void;
		};
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			kb.removeEventListener('submit', onSubmit);
			kb.removeEventListener('geometrychange', onGeometry);
			onOpen(false);
			resolve(value);
		};
		const onSubmit = () => finish(kb.value);
		const onGeometry = () => {
			if (kb.boundingRect.height === 0) finish(null);
		};
		kb.addEventListener('submit', onSubmit);
		kb.okButtonText = title;
		kb.value = initial;
		onOpen(true);
		try {
			kb.show(); // dispatches its own geometry event synchronously
			log(`keyboard shown: ${JSON.stringify(kb.boundingRect)}`);
			kb.addEventListener('geometrychange', onGeometry); // a zero rect from here on = dismissed
		} catch (err) {
			log(`keyboard failed: ${err instanceof Error ? err.message : String(err)}`);
			finish(null);
		}
	});
}

interface AppState {
	ui?: UiModel;
	player?: MediaPlayer;
	keyboardOpen: boolean;
	showStats: boolean;
	/**
	 * Diagnostic mode, cycled with X in the player, to attribute memory growth:
	 * 0 normal · 1 no video draw · 2 also no display/playback queries ·
	 * 3 also video paused (decoder idle, feed still running).
	 */
	diag: number;
}

/**
 * Per-frame loop: sample the pad, feed presses to the UI, then draw either
 * the video with its display, or the UI (only when its version changed), or
 * the console until the UI exists. Taps resolve against the last drawn hits.
 */
/** Diagnostic mode switch (X). Mode 3 pauses the video. */
let setDiag: (mode: number) => void = () => {};

function startPresenting(state: AppState): void {
	const ctx = screen.getContext('2d');
	setDiag = (mode: number) => {
		if (!state.player) return;
		const wasPaused = state.diag === 3;
		state.diag = mode;
		probes.diag = mode;
		if ((mode === 3) !== wasPaused) state.player.togglePause();
		log(`diag mode ${mode}`);
	};
	const input = new Input();
	const thumbs = new ThumbnailCache(() => state.ui?.invalidate(), 200);
	const images = (url: string | undefined, kind: 'poster' | 'backdrop' | 'logo') => thumbs.get(url, kind);
	let hits: HitRect[] = [];
	let drawnVersion = -1;
	let drawnFrames = -1;
	let drawnOsdVersion = -1;
	let drawnSubtitle = '';
	let lastRender = performance.now();

	attachTouch(screen, {
		onTap: (x, y) => {
			const target = hitTest(hits, x, y);
			if (target) state.ui?.tap(target);
		},
		onSwipe: (dx, dy) => state.ui?.swipe(dx, dy),
	});

	const render = () => {
		const now = performance.now();
		// No memory sampling here: Switch.memoryUsage() walks the native heap
		// (10-30 ms) and would turn one late frame into two.
		if (now - lastRender > probes.renderGapMs) {
			probes.renderGapMs = now - lastRender;
			probes.gapAtMs = now;
		}
		lastRender = now;
		const { ui, player } = state;
		if (ui && !state.keyboardOpen) {
			input.poll(now);
			for (const b of BUTTONS) {
				if (!input.pressed(b)) continue;
				if (b === 'minus') state.showStats = !state.showStats;
				else if (b === 'x' && ui.screen === 'player') setDiag((state.diag + 1) % 4);
				else ui.press(b);
			}
			ui.tick(now);
		}
		const video = ui?.screen === 'player' ? player?.video : undefined;
		if (ui && video && video.videoWidth > 0) {
			drawnVersion = -1; // force a UI redraw when we come back
			const frames = video.getVideoPlaybackQuality().totalVideoFrames;
			const subtitle = player?.subtitleText() ?? '';
			// Redraw on a new frame or on any model change (pause, scrub, display
			// shown/hidden); the bar advances with the frames themselves.
			const osdChanged = ui.version !== drawnOsdVersion;
			if (frames !== drawnFrames || osdChanged || subtitle !== drawnSubtitle) {
				drawnFrames = frames;
				drawnSubtitle = subtitle;
				drawnOsdVersion = ui.version;
				// Clear controls from the letterbox borders as well as the video.
				ctx.fillStyle = '#000';
				ctx.fillRect(0, 0, screen.width, screen.height);
				const scale = Math.min(screen.width / video.videoWidth, screen.height / video.videoHeight);
				const w = Math.round(video.videoWidth * scale);
				const h = Math.round(video.videoHeight * scale);
				const drawStart = performance.now();
				if (state.diag === 0) ctx.drawImage(video, (screen.width - w) >> 1, (screen.height - h) >> 1, w, h);
				probes.drawMaxMs = Math.max(probes.drawMaxMs, performance.now() - drawStart);
				hits = [];
				if (state.diag === 0) drawSubtitles(ctx, subtitle, ui.osd.visible);
				if (state.diag < 2) drawOsd(ctx, ui, player?.playback() ?? null, hits);
				if (state.showStats) {
					ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
					ctx.fillRect(0, 0, screen.width, 28);
					ctx.fillStyle = '#fff';
					ctx.font = '16px sans-serif';
					ctx.fillText(player?.status ?? '', 12, 19);
				}
			}
		} else if (ui) {
			if (ui.version !== drawnVersion) {
				drawnVersion = ui.version;
				hits = drawUi(ctx, ui, images);
			}
		} else {
			ctx.drawImage(console.canvas, 0, 0);
		}
		probes.renderMaxMs = Math.max(probes.renderMaxMs, performance.now() - now);
		requestAnimationFrame(render);
	};
	requestAnimationFrame(render);
}

async function main(): Promise<void> {
	// A rejected promise nobody awaited is fatal in nx.js; log it instead.
	addEventListener('unhandledrejection', (e) => {
		e.preventDefault();
		const r = e.reason;
		log(`unhandled rejection: ${r instanceof Error ? r.message : String(r)}`);
	});
	if (!FULL_MEMORY_APPLET_TYPES.has(Switch.appletType())) {
		log('Applet mode: relaunch via title override (hold R while opening a game).');
		return;
	}
	await Switch.mkdir(LOG_DIR).catch(() => undefined);
	Switch.setMediaPlaybackState(true); // keep the screen awake
	log(`stremio-nx build streaming-opt-20260926 | device ip ${Switch.networkInfo().ip} | canvas ${screen.width}x${screen.height}`);

	const state: AppState = { keyboardOpen: false, showStats: false, diag: 0 };
	startPresenting(state);

	// 1. Loopback control server the core's StreamingServer model talks to.
	// 30 peers + 16 pending connects + servers/DHT stay under the ~59-socket pool.
	const sessions = new TorrentSessions(nxPlatform, { log, defaultTrackers: DEFAULT_TRACKERS, maxPeers: 30 });
	const handler = createControlHandler({
		baseUrl: CONTROL_BASE,
		localIp: () => Switch.networkInfo().ip,
		createTorrent: (infoHash, announce) => sessions.createFromHash(infoHash, announce),
		statistics: (infoHash, fileIdx) => sessions.statistics(infoHash, fileIdx),
	});
	nxPlatform.listen(CONTROL_PORT, (conn) => void serveConnection(conn, handler), '127.0.0.1');
	log(`control server on ${CONTROL_BASE}`);

	// 2. stremio-core, pointed (by its default profile) at that server.
	installShims({ appVersion: '0.1.0', shellVersion: 'stremio-nx', storage: pickStorage() });
	const t0 = Date.now();
	const core = await StremioClient.create({ log });
	log(`core initialized in ${Date.now() - t0} ms`);
	const server = await core.reloadStreamingServer();
	log(`streaming server model: settings ${server.settings.type}, base ${server.baseUrl}`);
	const pairingCode = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
	const setupOrigin = () => `http://${Switch.networkInfo().ip}:${ADDON_PORT}`;
	let externalLink: string | undefined;
	let setupAvailable = false;
	try {
		const addonHandler = createAddonHandler({ origin: setupOrigin, code: pairingCode, list: () => core.addons(),
			install: url => core.installAddon(url), remove: url => core.removeAddon(url), changed: () => state.ui?.addonsChanged(), external: () => externalLink });
		nxPlatform.listen(ADDON_PORT, conn => void serveConnection(conn, addonHandler), '0.0.0.0');
		setupAvailable = true;
		log(`add-on setup server on port ${ADDON_PORT}`);
	} catch { log('add-on setup server unavailable; direct link installation still works'); }

	// 3. The UI drives the core and the player through these services.
	let currentHash: string | undefined;
	let currentHttp: HttpStream | undefined;
	let pendingStart: { resolve: () => void; reject: (e: Error) => void } | undefined;
	const stop = () => {
		pendingStart?.reject(new Error('cancelled'));
		pendingStart = undefined;
		state.player?.stop();
		state.player = undefined;
		currentHttp?.close();
		currentHttp = undefined;
		if (currentHash) sessions.stop(currentHash);
		currentHash = undefined;
		consoleHidden = false;
	};
	const services: UiServices = {
		addons: () => core.addons(),
		installAddon: url => core.installAddon(url),
		removeAddon: url => core.removeAddon(url),
		addonSetup: () => ({ url: setupAvailable ? setupOrigin() : 'Phone setup unavailable; press Y to install', code: setupAvailable ? pairingCode : '—' }),
		openExternal: async url => {
			if (!setupAvailable) throw new Error('Phone setup is unavailable. Restart the app and try again.');
			externalLink = httpUrl(url).href;
			return `Open ${setupOrigin()} on your phone. Code ${pairingCode}. Connect, then open the selected service link.`;
		},
		tracks: kind => state.player?.tracks(kind) ?? [],
		selectTrack: async (kind, id) => { if (state.player) await state.player.selectTrack(kind, id); },
		subtitleDelay: delta => {
			if (!state.player) return 0;
			if (delta !== undefined) state.player.subtitleDelay = Math.max(-60, Math.min(60, state.player.subtitleDelay + delta));
			return state.player.subtitleDelay;
		},
		trackNotice: () => state.player?.trackNotice() ?? '',
		catalogs: () => core.catalogs(),
		loadBoard: () => core.loadBoard(),
		continueWatching: () => core.continueWatching(),
		loadCatalog: (c) => core.loadCatalog(c.addonUrl, c.type, c.id),
		loadLibrary: () => core.loadLibrary(),
		search: (q) => core.search(q),
		promptText: (title, initial) => promptText(title, initial, (open) => { state.keyboardOpen = open; }),
		loadDetails: (item, videoId) => core.loadMetaDetails(item.type, item.id, videoId),
		play: async (option, meta, videoId, onProgress) => {
			// One promise that only ever rejects (cancel from B, or the timeout);
			// raced against each stage so a stall always surfaces on screen.
			let fail: (e: Error) => void = () => {};
			const failure = new Promise<never>((_, reject) => { fail = reject; });
			failure.catch(() => {}); // it is observed through the races below
			const timer = setTimeout(() => fail(new Error(`no playable data after ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS);
			const began = new Promise<void>((resolve) => { pendingStart = { resolve, reject: fail }; });
			const t0 = Date.now();
			let session: ReturnType<typeof sessions.getOrCreate> | undefined;
			const progress = setInterval(() => {
				const elapsed = Math.round((Date.now() - t0) / 1000);
				if (!session) { onProgress(`Opening video… ${elapsed} s · B cancels`); return; }
				const s = session.engine.stats();
				const pieces = s.totalPieces ? `${s.completedPieces}/${s.totalPieces} pieces` : 'fetching metadata';
				onProgress(`Connecting… ${elapsed} s · ${s.peers} peers (dht ${s.dhtPeers}) · ${pieces} · ${(s.downloadSpeed / MiB).toFixed(2)} MiB/s · B cancels`);
			}, 1000);
			try {
				onProgress('Asking the core for the stream…');
				const selected = await Promise.race([core.loadPlayer(option, meta, videoId), failure]);
				let input: HttpStream | ReturnType<typeof sessions.getOrCreate>['engine'];
				let file: { length: number; path: string[] };
				if (streamKind(selected) === 'url') {
					currentHttp = new HttpStream(selected);
					await Promise.race([currentHttp.open(), failure]);
					input = currentHttp;
					file = currentHttp;
					log(`play ${meta.name}: HTTP stream (${(file.length / MiB).toFixed(1)} MiB)`);
				} else {
					const request = torrentRequestFromStream(selected);
					if (!request) throw new Error('This source is not a playable torrent or HTTP(S) video.');
					log(`play ${meta.name}: torrent ${request.infoHash.toHex()} fileIdx ${request.fileIdx}`);
					currentHash = request.infoHash.toHex();
					session = sessions.getOrCreate(request);
					({ file } = await Promise.race([session.ready, failure]));
					input = session.engine;
					log(`streaming ${file.path.join('/')} (${(file.length / MiB).toFixed(1)} MiB)`);
				}
				state.player = new MediaPlayer(input, file, {
					log,
					subtitles: { addons: core.addons(), type: meta.type, videoId },
					onChanged: () => state.ui?.invalidate(),
					onStarted: () => { consoleHidden = true; pendingStart?.resolve(); pendingStart = undefined; },
					onEnded: () => state.ui?.stopPlayback(),
					onError: error => {
						if (pendingStart) fail(error);
						else { state.ui?.stopPlayback(); if (state.ui) { state.ui.message = error.message; state.ui.invalidate(); } }
					},
				});
				state.player.start();
				await Promise.race([began, failure]);
			} catch (err) {
				stop();
				throw err;
			} finally {
				clearTimeout(timer);
				clearInterval(progress);
			}
		},
		stop,
		togglePause: () => state.player?.togglePause(),
		seekTo: (seconds) => state.player?.seekTo(seconds),
		playback: () => (state.diag >= 2 ? null : state.player?.playback() ?? null),
		log,
	};
	state.ui = new UiModel(services);
	log(`ui ready: ${core.catalogs().length} catalogs`);
}

main().catch((err) => log(`FAILED: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`));
