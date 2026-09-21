/**
 * Video playback on the Switch: feeds verified torrent bytes or HTTP ranges
 * into `Video` through the patched runtime's MediaSource with a sliding
 * window that follows the decoder's read cursor. Owns the feed loop and the
 * per-second stats line; the caller draws `video` and `status`.
 */
import type { TorrentEngine } from '../torrent/engine';
import { HttpStream, HTTP_CHUNK } from './http-stream';
import { bufferTargets } from './buffering';
import { probes } from './main';
import { fetchTextLimited, type Addon } from '../stremio/addons';
import { findSubtitles, parseSubtitles, subtitleTextAt, type Cue, type SubtitleOption } from '../stremio/subtitles';
import type { TrackOption } from './ui';

const MiB = 1024 * 1024;
const PROVIDE_CHUNK = 8 * MiB; // max bytes provided per step

export interface PlayerOptions {
	log: (msg: string) => void;
	/** Fires once playback actually starts (the screen switches to the video). */
	onStarted?: () => void;
	/** Fires when the video reaches its end. */
	onEnded?: () => void;
	onChanged?: () => void;
	onError?: (error: Error) => void;
	subtitles?: { addons: Addon[]; type: string; videoId: string };
}

export class MediaPlayer {
	/** Set once playback has started; the presenter draws it. */
	video?: Video;
	/** One-line status for the on-screen bar, refreshed every second. */
	status = '';
	subtitleDelay = 0;
	subtitleNotice = '';
	#subtitleSelection = 'off';
	#subtitleOptions: SubtitleOption[] = [];
	#cues: Cue[] = [];
	#subtitleSearch = new AbortController();
	#subtitleLoad?: AbortController;
	#subtitleSeq = 0;
	#stopped = false;

	#engine?: TorrentEngine;
	#http?: HttpStream;
	#file: { length: number; path: string[] };
	#opts: PlayerOptions;
	#source: Switch.MediaSource;
	#video: Video;
	#feed?: ReturnType<typeof setInterval>;
	#stats?: ReturnType<typeof setInterval>;
	#started = false;
	#userPaused = false;
	#rebuffering = false;
	#seekEpoch = 0;

	constructor(input: TorrentEngine | HttpStream, file: { length: number; path: string[] }, opts: PlayerOptions) {
		if (input instanceof HttpStream) this.#http = input;
		else this.#engine = input;
		this.#file = file;
		this.#opts = opts;
		this.#source = new Switch.MediaSource(file.length);
		this.#video = new Video();
		this.#video.setRenderSize(screen.width, screen.height);
		this.#video.onerror = () => this.#fail(new Error('The video could not be decoded. Try another source.'));
		this.#video.oncanplay = () => opts.log('canplay');
		this.#video.addEventListener('ended', () => opts.onEnded?.());
		this.#video.src = this.#source.url;
	}

	#fail(error: Error): void {
		if (this.#stopped) return;
		this.#opts.log(`playback error: ${error.message}`);
		this.stop();
		this.#opts.onError?.(error);
	}

	get paused(): boolean {
		return this.#started ? this.#userPaused : this.#video.paused;
	}

	tracks(kind: 'audio' | 'subtitles'): TrackOption[] {
		const v = this.#video;
		const native = kind === 'audio' ? v.audioTracks : v.subtitleTracks;
		const rows = native.map(t => ({ id: kind === 'audio' ? String(t.id) : `embedded:${t.id}`,
			label: `${t.language}${t.label ? ' · ' + t.label : ''} · ${t.codec}${!t.supported ? ' (unsupported)' : ''}`,
			selected: kind === 'audio' ? t.id === v.selectedAudioTrack : this.#subtitleSelection === `embedded:${t.id}`, enabled: t.supported }));
		if (kind === 'audio') return rows;
		return [{ id: 'off', label: 'Off', selected: this.#subtitleSelection === 'off', enabled: true }, ...rows,
			...this.#subtitleOptions.map((t, i) => ({ id: `external:${i}`, label: t.label, selected: this.#subtitleSelection === `external:${i}`, enabled: true }))];
	}

	async selectTrack(kind: 'audio' | 'subtitles', id: string): Promise<void> {
		if (!this.tracks(kind).some(t => t.id === id && t.enabled)) throw new Error('Track is not available.');
		if (kind === 'audio') { this.#video.selectAudioTrack(Number(id)); return; }
		this.#subtitleLoad?.abort();
		const seq = ++this.#subtitleSeq;
		let cues: Cue[] = [];
		if (id.startsWith('external:')) {
			const option = this.#subtitleOptions[Number(id.slice(9))];
			this.#subtitleLoad = new AbortController();
			cues = parseSubtitles(await fetchTextLimited(option.url, 2 * MiB, this.#subtitleLoad.signal));
		}
		if (this.#stopped || seq !== this.#subtitleSeq) return;
		if (id.startsWith('embedded:')) this.#video.selectSubtitleTrack(Number(id.slice(9)));
		else if (this.#video.selectedSubtitleTrack >= 0) this.#video.selectSubtitleTrack(-1);
		this.#cues = cues;
		this.#subtitleSelection = id;
		this.#opts.onChanged?.();
	}

	subtitleText(): string {
		if (this.#subtitleSelection === 'off') return '';
		const time = this.#video.currentTime - this.subtitleDelay;
		return this.#subtitleSelection.startsWith('embedded:') ? this.#video.getSubtitleText(time) : subtitleTextAt(this.#cues, time);
	}

	trackNotice(): string { return this.#video.trackError || this.subtitleNotice; }

	async #findSubtitles(): Promise<void> {
		const request = this.#opts.subtitles;
		if (!request) return;
		this.subtitleNotice = 'Finding add-on subtitles…';
		this.#opts.onChanged?.();
		const result = await findSubtitles(request.addons, request.type, request.videoId, this.#file.path.at(-1) ?? '', this.#file.length, this.#subtitleSearch.signal);
		if (this.#stopped) return;
		this.#subtitleOptions = result.tracks;
		this.subtitleNotice = result.failed ? `${result.failed} subtitle provider(s) unavailable. Embedded tracks still work.` : result.tracks.length ? '' : 'No add-on subtitles found. Install a subtitle add-on for more languages.';
		this.#opts.onChanged?.();
	}

	/** Position, length, pause and buffering state for the on-screen display. */
	playback(): { time: number; duration: number; paused: boolean; buffering: boolean; aheadMiB: number } {
		const duration = this.#video.duration;
		const pos = this.#source.position;
		return {
			time: this.#video.currentTime,
			duration: Number.isFinite(duration) ? duration : 0,
			paused: this.paused,
			// The decoder is blocked on bytes we have not provided yet.
			buffering: this.#started && !this.#userPaused && (this.#rebuffering || this.#source.wanted >= 0),
			aheadMiB: this.#source.buffered(pos) / MiB,
		};
	}

	seekTo(seconds: number): void {
		if (!this.#started) return;
		const duration = this.#video.duration;
		const target = Math.max(0, Math.min(seconds, Number.isFinite(duration) ? duration - 1 : seconds));
		this.#opts.log(`seek ${this.#video.currentTime.toFixed(0)}s -> ${target.toFixed(0)}s`);
		this.#seekEpoch++;
		this.#video.currentTime = target;
	}

	togglePause(): void {
		if (!this.#started) return;
		this.#userPaused = !this.#userPaused;
		if (this.#userPaused) this.#video.pause();
		else if (!this.#rebuffering) void this.#video.play().catch(error => this.#fail(error));
	}

	/** Jump by `deltaSeconds`; the feed loop follows the decoder to the new offset. */
	seek(deltaSeconds: number): void {
		this.seekTo(this.#video.currentTime + deltaSeconds);
	}

	start(): void {
		void this.#findSubtitles().catch(() => { if (!this.#stopped) { this.subtitleNotice = 'Subtitle search failed.'; this.#opts.onChanged?.(); } });
		const log = this.#opts.log;
		const engine = this.#engine;
		const source = this.#source;
		const video = this.#video;
		const file = this.#file;

		// Both transports share time-based goals, a byte cap and rebuffer recovery.
		let pos = 0;
		let observedRate = 0;
		let targets = bufferTargets(file.length, video.duration);
		let prefix = targets.startup;
		let feedMaxMs = 0; // longest feed tick since the last stats line
		let feedIoMs = 0; // ... of which: engine.read + source.provide
		let feedEvictMs = 0; // ... of which: evict + discard
		let feedGapMs = 0; // longest pause between feed ticks (JS thread stalls)
		let lastTick = performance.now();
		let feeding = false;
		let readingFrom = 0, readingTo = 0;
		const cursorNow = () => { const wanted = source.wanted; return wanted >= 0 ? wanted : source.position; };
		const updatePlayback = (cursor: number) => {
			const ahead = source.buffered(cursor);
			const remaining = Math.max(0, file.length - cursor);
			if (!this.#started && video.readyState >= 2 && ahead >= Math.min(targets.startup, remaining)) {
				this.#started = true;
				this.video = video;
				log(`prebuffered ${(ahead / MiB).toFixed(1)} MiB — starting playback`);
				void video.play().then(() => { if (!this.#stopped) this.#opts.onStarted?.(); }, error => this.#fail(error));
			} else if (this.#started && !video.ended) {
				if (!this.#rebuffering && !this.#userPaused && ahead < targets.low && ahead < remaining) {
					this.#rebuffering = true;
					video.pause();
					log(`buffering: ${(ahead / MiB).toFixed(1)} MiB ahead; refill to ${(targets.resume / MiB).toFixed(1)} MiB`);
					this.#opts.onChanged?.();
				} else if (this.#rebuffering && !video.seeking && ahead >= Math.min(targets.resume, remaining)) {
					this.#rebuffering = false;
					log(`buffer recovered: ${(ahead / MiB).toFixed(1)} MiB ahead${this.#userPaused ? ' (user paused)' : ''}`);
					if (!this.#userPaused) void video.play().catch(error => this.#fail(error));
					this.#opts.onChanged?.();
				}
			}
		};
		const fillHttp = async () => {
			feeding = true;
			try {
				while (!this.#stopped) {
					const cursor = cursorNow();
					const ahead = source.buffered(cursor);
					updatePlayback(cursor);
					readingFrom = cursor + ahead;
					// Leave one range of headroom instead of opening tiny top-up requests.
					if (readingFrom >= file.length || ahead > targets.ahead - HTTP_CHUNK) return;
					readingTo = Math.min(file.length, readingFrom + HTTP_CHUNK);
					await this.#http!.read(readingFrom, readingTo - readingFrom, (offset, bytes) => {
						if (this.#stopped) throw new DOMException('Playback stopped.', 'AbortError');
						const now = cursorNow();
						const wanted = source.wanted;
						if (wanted >= 0 && !source.buffered(wanted) && (wanted < readingFrom || wanted >= readingTo)) {
							throw new DOMException('Seek changed the read range.', 'AbortError');
						}
						const keepFrom = Math.max(0, now - targets.behind), keepTo = Math.min(file.length, now + targets.ahead);
						const from = Math.max(offset, keepFrom), to = Math.min(offset + bytes.length, keepTo);
						if (from >= to) throw new DOMException('Seek changed the cache window.', 'AbortError');
						const ioStart = performance.now();
						source.retain(keepFrom, keepTo, prefix);
						source.provide(from, bytes.subarray(from - offset, to - offset));
						feedIoMs = Math.max(feedIoMs, performance.now() - ioStart);
						updatePlayback(now);
					});
					// Continue immediately while there is room for another full range.
				}
			} catch (error) {
				if (!(error instanceof Error && error.name === 'AbortError')) this.#fail(error instanceof Error ? error : new Error('Video read failed.'));
			} finally { feeding = false; }
		};
		this.#feed = setInterval(() => {
			if (this.#stopped) return;
			try {
			const tickStart = performance.now();
			feedGapMs = Math.max(feedGapMs, tickStart - lastTick);
			lastTick = tickStart;
			pos = source.position;
			const want = source.wanted; // >= 0 when the decoder is blocked
			const cursor = want >= 0 ? want : pos;
			targets = bufferTargets(file.length, video.duration, observedRate);
			if (!this.#started) prefix = targets.startup;
			const keepTo = Math.min(file.length, cursor + targets.ahead);
			source.retain(Math.max(0, cursor - targets.behind), keepTo, prefix);
			updatePlayback(cursor);
			if (this.#http) {
				if (feeding && ((want >= 0 && !source.buffered(want) && (want < readingFrom || want >= readingTo)) || readingFrom >= keepTo)) this.#http.cancel();
				if (!feeding) void fillHttp();
				feedMaxMs = Math.max(feedMaxMs, performance.now() - tickStart);
				return;
			}
			let providedUpTo = cursor + source.buffered(cursor);
			engine!.setReadHead(providedUpTo);
			const evictStart = performance.now();
			// MediaSource owns delivered bytes, including the prefix and seek-back cache.
			// Keep only the torrent frontier to avoid a second copy of the whole window.
			engine!.retainRange(providedUpTo, Math.min(file.length, keepTo + PROVIDE_CHUNK));
			feedEvictMs = Math.max(feedEvictMs, performance.now() - evictStart);
			const ioStart = performance.now();
			let budget = PROVIDE_CHUNK;
			while (providedUpTo < keepTo && budget > 0) {
				const bytes = engine!.read(providedUpTo, Math.min(budget, MiB, keepTo - providedUpTo));
				if (bytes.length === 0) break; // next piece not verified yet
				source.provide(providedUpTo, bytes);
				providedUpTo += bytes.length;
				budget -= bytes.length;
			}
			feedIoMs = Math.max(feedIoMs, performance.now() - ioStart);

			updatePlayback(cursor);
			feedMaxMs = Math.max(feedMaxMs, performance.now() - tickStart);
			} catch (error) {
				if (!(error instanceof Error && error.name === 'AbortError')) this.#fail(error instanceof Error ? error : new Error('Video read failed.'));
			}
		}, 50);

		// Stats once per second; flags a stall (time not advancing while playing).
		let lastPieces = 0;
		let lastReceived = 0;
		let lastTime = -1;
		let lastRatePos = 0, lastSeekEpoch = this.#seekEpoch;
		let lastStatsAt = performance.now();
		let statsMs = 0;
		this.#stats = setInterval(() => {
			const tickStart = performance.now();
			const s = engine?.stats();
			const ratePieces = (s?.completedPieces ?? 0) - lastPieces;
			lastPieces = s?.completedPieces ?? 0;
			const received = this.#http?.receivedBytes ?? 0;
			const httpRate = (received - lastReceived) / MiB / Math.max(.001, (tickStart - lastStatsAt) / 1000);
			lastStatsAt = tickStart;
			lastReceived = received;
			const aheadMiB = (source.buffered(pos) / MiB).toFixed(1);
			const t = video.currentTime;
			const elapsed = t - lastTime, consumed = pos - lastRatePos;
			if (lastSeekEpoch !== this.#seekEpoch) observedRate = 0;
			else if (this.#started && !video.paused && !video.seeking && elapsed >= .5 && elapsed <= 3 && consumed > 0 && consumed < targets.ahead) {
				observedRate = Math.max(consumed / elapsed, observedRate * .9);
			}
			lastRatePos = pos;
			lastSeekEpoch = this.#seekEpoch;
			const stalled = this.#started && !video.paused && lastTime >= 0 && t <= lastTime + 0.05;
			lastTime = t;
			const heap = Switch.memoryUsage();
			const memory = engine?.memoryUsage();
			const native = heap as unknown as { totalPhysicalSize?: number; nativeHeapTotal?: number; nativeHeapUsed?: number; dataArenaUsed?: number; dataArenaCommitted?: number; dataArenaSize?: number };
			probes.lastHeap = heap.usedHeapSize;
			const q = video.getVideoPlaybackQuality();
			const frame = video.getFrameStats();
			// Negative: the longest render pause ended before this tick; near 0: right at it.
			const gapPhase = probes.gapAtMs ? Math.round(probes.gapAtMs - tickStart) : 0;
			log(`decoder ${video.decoder} source ${video.videoWidth}x${video.videoHeight} render ${frame.width}x${frame.height} transfer max ${frame.transferMs.toFixed(1)} ms convert max ${frame.convertMs.toFixed(1)} ms | ` +
				(s ? `peers ${s.peers} (dht ${s.dhtPeers}) | pieces ${s.completedPieces}/${s.totalPieces} (+${ratePieces}/s) | ` : `HTTP ${httpRate.toFixed(2)} MiB/s requests ${this.#http?.requests ?? 0} retries ${this.#http?.retries ?? 0} | `) +
					`buffer ${this.#rebuffering ? 'refilling' : this.#userPaused ? 'paused' : this.#started ? 'playing' : 'starting'} est ${(source.buffered(pos) / targets.rate).toFixed(1)}s goal ${(targets.ahead / MiB).toFixed(0)} MiB prefix ${(prefix / MiB).toFixed(1)} MiB | ` +
					`ahead ${aheadMiB} MiB | buffers cache ${((memory?.cachedBytes ?? 0) / MiB).toFixed(1)} partial ${((memory?.partialBytes ?? 0) / MiB).toFixed(1)} source ${(source.storedBytes / MiB).toFixed(1)} MiB v8physical ${((native.totalPhysicalSize ?? 0) / MiB).toFixed(0)} nativeFree ${(((native.nativeHeapTotal ?? 0) - (native.nativeHeapUsed ?? 0)) / MiB).toFixed(0)} fonts ${fonts.size} | t=${t.toFixed(0)}s${stalled ? ' STALL' : ''} | ` +
					`dataArena live/committed/limit ${((native.dataArenaUsed ?? 0) / MiB).toFixed(0)}/${((native.dataArenaCommitted ?? 0) / MiB).toFixed(0)}/${((native.dataArenaSize ?? 0) / MiB).toFixed(0)} MiB | ` +
					`frames ${q.totalVideoFrames}/${q.droppedVideoFrames} dropped | feed max ${feedMaxMs.toFixed(0)} ms (io ${feedIoMs.toFixed(0)} ev ${feedEvictMs.toFixed(0)}) gap ${feedGapMs.toFixed(0)} ms stats ${statsMs.toFixed(0)} ms render max ${probes.renderMaxMs.toFixed(0)} (draw ${probes.drawMaxMs.toFixed(0)}) gap ${probes.renderGapMs.toFixed(0)} @${gapPhase} heap ${(probes.heapBeforeGap / MiB).toFixed(1)}->${(probes.heapAfterGap / MiB).toFixed(1)} log ${probes.logMaxMs.toFixed(0)} ms | ` +
					`diag ${probes.diag} conn ${s ? `${s.connectAttempts - s.connectFailures}/${s.connectAttempts}` : 'HTTP'} | heap ${(heap.usedHeapSize / MiB).toFixed(0)}/${(heap.heapSizeLimit / MiB).toFixed(0)} MiB ext ${((heap as unknown as { externalMemory?: number }).externalMemory ?? 0) / MiB | 0} v8malloc ${((heap as unknown as { mallocedMemory?: number }).mallocedMemory ?? 0) / MiB | 0} native ${((heap as unknown as { nativeHeapUsed?: number }).nativeHeapUsed ?? 0) / MiB | 0} MiB | pos ${(pos / MiB).toFixed(1)}`,
			);
			this.status =
				`t=${t.toFixed(0)}s | ahead ${aheadMiB} MiB | ${s ? `peers ${s.peers} | pieces ${s.completedPieces}/${s.totalPieces}` : 'HTTP stream'} | ` +
				`${video.decoder} | frames ${q.totalVideoFrames}/${q.droppedVideoFrames} dropped | gap ${feedGapMs.toFixed(0)} ms`;
			feedMaxMs = 0;
			feedIoMs = 0;
			feedEvictMs = 0;
			feedGapMs = 0;
			probes.renderMaxMs = 0;
			probes.renderGapMs = 0;
			probes.gapAtMs = 0;
			probes.drawMaxMs = 0;
			probes.logMaxMs = 0;
			statsMs = performance.now() - tickStart;
		}, 1000);
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#subtitleSeq++;
		this.#subtitleSearch.abort();
		this.#subtitleLoad?.abort();
		this.#http?.close();
		this.#cues = [];
		this.#subtitleOptions = [];
		if (this.#feed) clearInterval(this.#feed);
		if (this.#stats) clearInterval(this.#stats);
		this.#video.pause();
		this.#source.close();
		this.#video.src = '';
		this.video = undefined;
	}
}
