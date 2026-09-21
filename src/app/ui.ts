/**
 * The app's screens as one state machine, pure of canvas, controller and
 * touch so the host tests can drive it:
 *
 *   rail: home | discover | library | search
 *   section screen: rows of poster cards (board rows, a catalog grid, the
 *   library, search results), a d-pad cursor, the rail on the left
 *   details: backdrop + info + a vertical list (episodes, then streams)
 *   player: on-screen display with a progress bar, scrubbing, pause
 *
 * `main.ts` feeds it button presses, taps and swipes, and draws it.
 */
import type { CatalogRef, CatalogRow, MetaDetails, MetaItem, MetaPreview, StreamOption, Video } from '../stremio/client';
import type { Button } from './input';
import type { Addon } from '../stremio/addons';
import { streamKind } from '../stremio/streams';

export type Section = 'home' | 'discover' | 'library' | 'search' | 'addons';
export const SECTIONS: Section[] = ['home', 'discover', 'library', 'search', 'addons'];
export const SECTION_TITLES: Record<Section, string> = { home: 'Home', discover: 'Discover', library: 'Library', search: 'Search', addons: 'Add-ons' };

export type Screen = 'section' | 'details' | 'player';

export interface Card {
	meta: MetaPreview;
	label: string;
	/** "See all" card: opens this catalog in Discover. */
	seeAll?: CatalogRef;
}

export interface Row {
	title: string;
	kind: 'posters' | 'chips';
	cards: Card[];
}

export interface ListRow {
	label: string;
	detail?: string;
	enabled: boolean;
}

/** What a tap landed on; the renderer records these with each drawn element. */
export type HitTarget =
	| { kind: 'rail'; section: Section }
	| { kind: 'card'; row: number; col: number }
	| { kind: 'listRow'; index: number }
	| { kind: 'back' }
	| { kind: 'video' }
	| { kind: 'osdPause' }
	| { kind: 'osdBack' }
	| { kind: 'tracks'; tab: 'audio' | 'subtitles' }
	| { kind: 'trackRow'; index: number }
	| { kind: 'subtitleDelay'; delta: number }
	| { kind: 'closeTracks' }
	| { kind: 'addonRow'; index: number }
	| { kind: 'addonInstall' }
	| { kind: 'osdSeek'; fraction: number };

export interface TrackOption { id: string; label: string; selected: boolean; enabled: boolean }

export interface Playback {
	time: number;
	duration: number;
	paused: boolean;
	/** The decoder is waiting for bytes (after a seek, or a slow swarm). */
	buffering?: boolean;
	/** Contiguous data ahead of the decoder, in MiB. */
	aheadMiB?: number;
}

/** What the UI needs from the core, the player and the console, without knowing them. */
export interface UiServices {
	catalogs(): CatalogRef[];
	loadBoard(): Promise<CatalogRow[]>;
	continueWatching(): MetaPreview[];
	loadCatalog(catalog: CatalogRef): Promise<MetaPreview[]>;
	loadLibrary(): Promise<MetaPreview[]>;
	search(query: string): Promise<CatalogRow[]>;
	/** On-screen keyboard; null when dismissed. */
	promptText(title: string, initial: string): Promise<string | null>;
	loadDetails(item: MetaPreview, videoId?: string): Promise<MetaDetails>;
	/** Start playing; resolves once playback has begun. `onProgress` updates the footer meanwhile. */
	play(option: StreamOption, meta: MetaItem, videoId: string, onProgress: (message: string) => void): Promise<void>;
	stop(): void;
	togglePause(): void;
	seekTo(seconds: number): void;
	playback(): Playback | null;
	tracks(kind: 'audio' | 'subtitles'): TrackOption[];
	selectTrack(kind: 'audio' | 'subtitles', id: string): Promise<void>;
	subtitleDelay(delta?: number): number;
	trackNotice(): string;
	addons(): Addon[];
	installAddon(url: string): Promise<void>;
	removeAddon(url: string): Promise<void>;
	addonSetup(): { url: string; code: string };
	openExternal(url: string): Promise<string>;
	log(msg: string): void;
}

interface SectionState {
	rows: Row[];
	row: number;
	col: number;
	loaded: boolean;
	/** Discover: the catalog whose grid is shown. */
	catalog?: CatalogRef;
	/** Search: the last query. */
	query?: string;
}

export interface DetailsState {
	meta: MetaItem;
	streams: StreamOption[];
	videos: Video[];
	mode: 'episodes' | 'streams';
	cursor: number;
	videoId: string;
}

export interface OsdState {
	visible: boolean;
	/** Timestamp after which the display hides (unless paused or scrubbing). */
	hideAt: number;
	/** Seek target while scrubbing with the d-pad; committed after a short pause. */
	scrubTarget?: number;
	commitAt?: number;
	/** Consecutive scrub presses (drives the accelerating step). */
	scrubPresses: number;
	lastScrubAt: number;
}

const GRID_COLUMNS = 7;
const OSD_SHOW_MS = 4000;
const SCRUB_COMMIT_MS = 450;
const SCRUB_STEPS = [10, 10, 10, 30, 30, 60];
const SEE_ALL_ID = '__see_all__';

export class UiModel {
	screen: Screen = 'section';
	section: Section = 'home';
	railFocused = false;
	railIndex = 0;
	sections: Record<Section, SectionState> = {
		home: { rows: [], row: 0, col: 0, loaded: false },
		discover: { rows: [], row: 0, col: 0, loaded: false },
		library: { rows: [], row: 0, col: 0, loaded: false },
		search: { rows: [], row: 0, col: 0, loaded: false },
		addons: { rows: [], row: 0, col: 0, loaded: false },
	};
	details?: DetailsState;
	osd: OsdState = { visible: false, hideAt: 0, scrubPresses: 0, lastScrubAt: 0 };
	/** Footer text while something loads, or after an error. */
	message = '';
	busy = false;
	/** Bumped on every visible change so the presenter redraws lazily. */
	version = 0;
	mediaMenu?: { kind: 'audio' | 'subtitles'; cursor: number };
	trackBusy = false;
	addonCursor = 0;
	addonConfirm?: string;

	#services: UiServices;
	#now: () => number;
	#trackOperation = 0;

	constructor(services: UiServices, now: () => number = () => performance.now()) {
		this.#services = services;
		this.#now = now;
		void this.#enterSection('home');
	}

	// ---- queries for the renderer ----

	current(): SectionState {
		return this.sections[this.section];
	}

	title(): string {
		switch (this.screen) {
			case 'section': {
				const s = this.current();
				if (this.section === 'discover' && s.catalog) return `${s.catalog.name} · ${s.catalog.addonName}`;
				if (this.section === 'search' && s.query) return `Search: ${s.query}`;
				return SECTION_TITLES[this.section];
			}
			case 'details':
			case 'player':
				return this.details?.meta.name ?? '';
		}
	}

	hint(): string {
		switch (this.screen) {
			case 'player':
				return 'A pause   ◀ ▶ scrub   Y audio/subtitles   B back';
			case 'details':
				return 'A select   B back';
			default:
				if (this.section === 'addons') return this.addonConfirm ? 'A confirm removal   B cancel' : 'Y install link   A remove selected   L/R sections';
				return this.section === 'search' ? 'Y new search   A open   B rail   + exit' : 'A open   L/R sections   + exit';
		}
	}

	/** The vertical list on the details screen (episodes or streams). */
	listRows(): ListRow[] {
		const d = this.details;
		if (!d) return [];
		if (d.mode === 'episodes') return d.videos.map((v) => ({ label: videoLabel(v), detail: v.released?.slice(0, 10), enabled: true }));
		return d.streams.map((s) => ({
			label: `${s.stream.name ?? s.addonName}: ${(s.stream.title ?? s.stream.description ?? '').replace(/\s+/g, ' ')}`.slice(0, 90),
			detail: `${{ torrent: 'torrent', url: 'HTTP video', external: 'open on phone', unsupported: 'unsupported source' }[streamKind(s.stream)]} · ${s.addonName}`,
			enabled: streamKind(s.stream) !== 'unsupported',
		}));
	}

	focusedCard(): Card | undefined {
		const s = this.current();
		return s.rows[s.row]?.cards[s.col];
	}

	// ---- input ----

	/** One button press. Async work runs in the background; `busy` gates input meanwhile. */
	press(button: Button): void {
		if (this.busy) {
			if (button === 'b') this.#services.stop(); // abandon a pending load/connect
			return;
		}
		switch (this.screen) {
			case 'player':
				return this.#pressInPlayer(button);
			case 'details':
				return this.#pressInDetails(button);
			default:
				return this.#pressInSection(button);
		}
	}

	/** Touch: something drawn was tapped. */
	tap(target: HitTarget): void {
		if (this.busy) return;
		if (this.mediaMenu && !['tracks', 'trackRow', 'subtitleDelay', 'closeTracks'].includes(target.kind)) return;
		switch (target.kind) {
			case 'tracks': return this.openTracks(target.tab);
			case 'closeTracks': this.mediaMenu = undefined; return this.#showOsd();
			case 'trackRow':
				if (this.mediaMenu && this.trackRows()[target.index]) { this.mediaMenu.cursor = target.index; void this.#selectTrack(); }
				return;
			case 'subtitleDelay': this.#services.subtitleDelay(target.delta); return this.#touch();
			case 'addonRow': this.addonCursor = target.index; void this.#activateAddon(); return;
			case 'addonInstall': void this.#installAddon(); return;
			case 'rail':
				void this.#enterSection(target.section);
				return;
			case 'card': {
				const s = this.current();
				if (!s.rows[target.row]?.cards[target.col]) return;
				this.railFocused = false;
				s.row = target.row;
				s.col = target.col;
				this.#touch();
				void this.#activateCard();
				return;
			}
			case 'listRow':
				if (!this.details) return;
				this.details.cursor = target.index;
				this.#touch();
				void this.#activateListRow();
				return;
			case 'back':
				return this.press('b');
			case 'video':
				return this.#showOsd();
			case 'osdPause':
				this.#services.togglePause();
				return this.#showOsd();
			case 'osdBack':
				return this.stopPlayback();
			case 'osdSeek': {
				const p = this.#services.playback();
				if (p && p.duration > 0) this.#services.seekTo(target.fraction * p.duration);
				return this.#showOsd();
			}
		}
	}

	/** Touch: a horizontal or vertical swipe on the section screen, in card steps. */
	swipe(dxSteps: number, dySteps: number): void {
		if (this.busy || this.screen !== 'section') return;
		const s = this.current();
		if (dySteps !== 0) this.#moveRow(s, dySteps);
		if (dxSteps !== 0) this.#moveCol(s, dxSteps);
	}

	/** Per-frame housekeeping: hides the display and commits a pending scrub. Returns true if it changed something. */
	tick(now: number): boolean {
		let changed = false;
		if (this.screen === 'player') {
			const p = this.#services.playback();
			if (this.osd.scrubTarget !== undefined && this.osd.commitAt !== undefined && now >= this.osd.commitAt) {
				this.#services.seekTo(this.osd.scrubTarget);
				this.osd.scrubTarget = undefined;
				this.osd.commitAt = undefined;
				this.osd.scrubPresses = 0;
				this.osd.hideAt = now + OSD_SHOW_MS;
				changed = true;
			}
			const buffering = p?.buffering ?? false;
			const keep = !!this.mediaMenu || (p?.paused ?? false) || buffering || this.osd.scrubTarget !== undefined;
			if (buffering && !this.osd.visible) {
				this.osd.visible = true;
				changed = true;
			}
			if (this.osd.visible && !keep && now >= this.osd.hideAt) {
				this.osd.visible = false;
				changed = true;
			}
		}
		if (changed) this.#touch();
		return changed;
	}

	/** Leave the player (also called when the video ends). */
	stopPlayback(): void {
		if (this.screen !== 'player') return;
		this.#services.stop();
		this.mediaMenu = undefined;
		this.trackBusy = false;
		this.#trackOperation++;
		this.osd = { visible: false, hideAt: 0, scrubPresses: 0, lastScrubAt: 0 };
		this.screen = 'details';
		this.#touch();
	}

	/** Live status for the footer while a load is in flight. */
	progress(message: string): void {
		if (!this.busy) return;
		this.message = message;
		this.#touch();
	}

	/** Ask the presenter to redraw (e.g. a poster finished loading). */
	invalidate(): void {
		this.#touch();
	}

	addons(): Addon[] { return this.#services.addons(); }
	addonSetup(): { url: string; code: string } { return this.#services.addonSetup(); }
	addonsChanged(): void {
		for (const section of ['home', 'discover', 'search'] as const) this.sections[section].loaded = false;
		this.addonCursor = Math.max(0, Math.min(this.addonCursor, this.addons().length - 1));
		this.addonConfirm = undefined;
		this.#touch();
	}

	openTracks(kind: 'audio' | 'subtitles'): void {
		if (this.screen !== 'player') return;
		this.osd.scrubTarget = undefined;
		this.osd.commitAt = undefined;
		this.message = '';
		const rows = this.#services.tracks(kind);
		this.mediaMenu = { kind, cursor: Math.max(0, rows.findIndex(r => r.selected)) };
		this.#showOsd();
	}
	trackRows(): TrackOption[] { return this.mediaMenu ? this.#services.tracks(this.mediaMenu.kind) : []; }
	trackNotice(): string { return this.message || this.#services.trackNotice(); }
	subtitleDelay(): number { return this.#services.subtitleDelay(); }

	async #selectTrack(): Promise<void> {
		const menu = this.mediaMenu, row = menu && this.trackRows()[menu.cursor];
		if (!menu || !row?.enabled || this.trackBusy) return;
		this.trackBusy = true;
		const operation = ++this.#trackOperation;
		this.message = 'Loading track…';
		this.#touch();
		try { await this.#services.selectTrack(menu.kind, row.id); if (operation === this.#trackOperation) this.message = ''; }
		catch (error) { if (operation === this.#trackOperation) this.message = error instanceof Error ? error.message : 'Could not load this track.'; }
		finally { if (operation === this.#trackOperation) { this.trackBusy = false; this.#touch(); } }
	}

	async #installAddon(): Promise<void> {
		await this.#run('Enter the add-on install link…', async () => {
			const url = await this.#services.promptText('Install', 'https://');
			if (!url?.trim()) return;
			this.progress('Installing add-on…');
			await this.#services.installAddon(url);
			this.addonsChanged();
			this.message = 'Add-on installed.';
		});
	}

	async #activateAddon(): Promise<void> {
		const addon = this.addons()[this.addonCursor];
		if (!addon) return;
		if (addon.flags?.protected) { this.message = 'This built-in add-on cannot be removed.'; this.#touch(); return; }
		if (this.addonConfirm !== addon.transportUrl) {
			this.addonConfirm = addon.transportUrl;
			this.message = `Remove ${addon.manifest.name}? A confirms · B cancels`;
			this.#touch();
			return;
		}
		await this.#run('Removing add-on…', async () => {
			await this.#services.removeAddon(addon.transportUrl);
			this.addonsChanged();
			this.message = 'Add-on removed.';
		});
	}

	// ---- section screen ----

	#pressInSection(button: Button): void {
		const s = this.current();
		if (button === 'l' || button === 'r') {
			const i = SECTIONS.indexOf(this.section) + (button === 'l' ? -1 : 1);
			const next = SECTIONS[(i + SECTIONS.length) % SECTIONS.length];
			void this.#enterSection(next);
			return;
		}
		if (this.railFocused) return this.#pressInRail(button);
		if (this.section === 'addons') {
			if (button === 'y') { void this.#installAddon(); return; }
			if (button === 'a') { void this.#activateAddon(); return; }
			if (button === 'b' && this.addonConfirm) { this.addonConfirm = undefined; this.message = ''; this.#touch(); return; }
			if (button === 'up' || button === 'down') {
				this.addonCursor = Math.max(0, Math.min(this.addons().length - 1, this.addonCursor + (button === 'up' ? -1 : 1)));
				this.addonConfirm = undefined; this.message = ''; this.#touch(); return;
			}
		}
		switch (button) {
			case 'up':
				return this.#moveRow(s, -1);
			case 'down':
				return this.#moveRow(s, 1);
			case 'left':
				if (s.col === 0 || s.rows.length === 0) {
					this.railFocused = true;
					this.railIndex = SECTIONS.indexOf(this.section);
					return this.#touch();
				}
				return this.#moveCol(s, -1);
			case 'right':
				return this.#moveCol(s, 1);
			case 'a':
				return void this.#activateCard();
			case 'y':
				if (this.section === 'search') void this.#promptSearch();
				return;
			case 'b':
				if (this.section !== 'home') {
					this.railFocused = true;
					this.railIndex = SECTIONS.indexOf(this.section);
					this.#touch();
				}
				return;
		}
	}

	#pressInRail(button: Button): void {
		switch (button) {
			case 'up':
				this.railIndex = Math.max(0, this.railIndex - 1);
				return this.#touch();
			case 'down':
				this.railIndex = Math.min(SECTIONS.length - 1, this.railIndex + 1);
				return this.#touch();
			case 'a':
				this.railFocused = false;
				void this.#enterSection(SECTIONS[this.railIndex]);
				return;
			case 'right':
			case 'b':
				this.railFocused = false;
				return this.#touch();
		}
	}

	#moveRow(s: SectionState, delta: number): void {
		if (s.rows.length === 0) return;
		const next = Math.max(0, Math.min(s.rows.length - 1, s.row + delta));
		if (next === s.row) return;
		s.row = next;
		s.col = Math.min(s.col, Math.max(0, s.rows[next].cards.length - 1));
		if (s.rows[next].kind === 'chips') this.#selectChip(s, s.col);
		this.#touch();
	}

	#moveCol(s: SectionState, delta: number): void {
		const row = s.rows[s.row];
		if (!row || row.cards.length === 0) return;
		const next = Math.max(0, Math.min(row.cards.length - 1, s.col + delta));
		if (next === s.col) return;
		s.col = next;
		if (row.kind === 'chips') this.#selectChip(s, next);
		this.#touch();
	}

	/** Discover: highlight a catalog chip; its grid loads when it is activated. */
	#selectChip(_s: SectionState, _col: number): void {}

	async #enterSection(section: Section): Promise<void> {
		this.section = section;
		this.screen = 'section';
		this.railFocused = false;
		this.message = '';
		this.addonConfirm = undefined;
		this.#touch();
		const s = this.sections[section];
		if (s.loaded) return;
		switch (section) {
			case 'addons': return;
			case 'home':
				return this.#run('Loading…', async () => {
					const rows = await this.#services.loadBoard();
					s.rows = boardRows(this.#services.continueWatching(), rows);
					s.loaded = true;
					s.row = 0;
					s.col = 0;
				});
			case 'discover': {
				s.rows = [{ title: 'Catalogs', kind: 'chips', cards: this.#services.catalogs().map((c) => ({ meta: { id: `${c.addonUrl}|${c.type}|${c.id}`, type: c.type, name: c.name }, label: `${c.name} · ${c.type}`, seeAll: c })) }];
				s.loaded = true;
				s.row = 0;
				s.col = 0;
				this.#touch();
				return;
			}
			case 'library':
				return this.#run('Loading library…', async () => {
					const items = await this.#services.loadLibrary();
					s.rows = gridRows(items, GRID_COLUMNS);
					s.loaded = true;
					s.row = 0;
					s.col = 0;
					if (items.length === 0) this.message = 'Your library is empty. Watched titles show up here.';
				});
			case 'search':
				return this.#promptSearch();
		}
	}

	/** Discover: open a catalog as a grid under the chips row. */
	async openCatalog(catalog: CatalogRef): Promise<void> {
		const s = this.sections.discover;
		this.section = 'discover';
		this.screen = 'section';
		this.railFocused = false;
		if (!s.loaded) {
			s.rows = [{ title: 'Catalogs', kind: 'chips', cards: this.#services.catalogs().map((c) => ({ meta: { id: `${c.addonUrl}|${c.type}|${c.id}`, type: c.type, name: c.name }, label: `${c.name} · ${c.type}`, seeAll: c })) }];
			s.loaded = true;
		}
		const chipIndex = s.rows[0].cards.findIndex((c) => c.seeAll?.addonUrl === catalog.addonUrl && c.seeAll.type === catalog.type && c.seeAll.id === catalog.id);
		await this.#run(`Loading ${catalog.name}…`, async () => {
			const items = await this.#services.loadCatalog(catalog);
			s.catalog = catalog;
			s.rows = [s.rows[0], ...gridRows(items, GRID_COLUMNS)];
			s.row = items.length > 0 ? 1 : 0;
			s.col = items.length > 0 ? 0 : Math.max(0, chipIndex);
		});
	}

	async #promptSearch(): Promise<void> {
		const s = this.sections.search;
		const query = await this.#services.promptText('Search', s.query ?? '');
		if (query === null || query.trim() === '') {
			if (!s.loaded) {
				s.loaded = true;
				this.message = 'Press Y to search.';
				this.#touch();
			}
			return;
		}
		await this.#run(`Searching “${query.trim()}”…`, async () => {
			const rows = await this.#services.search(query.trim());
			s.query = query.trim();
			s.rows = rows.map((r) => ({ title: `${r.name} · ${r.type}`, kind: 'posters' as const, cards: r.items.map(cardOf) }));
			s.loaded = true;
			s.row = 0;
			s.col = 0;
			if (rows.length === 0) this.message = 'No results.';
		});
	}

	async #activateCard(): Promise<void> {
		const card = this.focusedCard();
		if (!card) return;
		if (card.seeAll) return void this.openCatalog(card.seeAll);
		await this.#openDetails(card.meta);
	}

	async #openDetails(item: MetaPreview): Promise<void> {
		await this.#run(`Loading ${item.name}…`, async () => {
			const details = await this.#services.loadDetails(item);
			const videos = details.meta.videos ?? [];
			this.details = { meta: details.meta, streams: details.streams, videos, mode: videos.length > 0 ? 'episodes' : 'streams', cursor: 0, videoId: item.id };
			this.screen = 'details';
		});
	}

	// ---- details screen ----

	#pressInDetails(button: Button): void {
		const d = this.details;
		if (!d) return;
		const rows = this.listRows();
		switch (button) {
			case 'up':
			case 'down': {
				if (rows.length === 0) return;
				d.cursor = (d.cursor + (button === 'up' ? -1 : 1) + rows.length) % rows.length;
				return this.#touch();
			}
			case 'a':
				return void this.#activateListRow();
			case 'b':
				if (d.mode === 'streams' && d.videos.length > 0) {
					d.mode = 'episodes';
					d.cursor = Math.max(0, d.videos.findIndex((v) => v.id === d.videoId));
					return this.#touch();
				}
				this.screen = 'section';
				this.message = '';
				return this.#touch();
		}
	}

	async #activateListRow(): Promise<void> {
		const d = this.details;
		if (!d) return;
		if (d.mode === 'episodes') {
			const video = d.videos[d.cursor];
			if (!video) return;
			await this.#run(`Loading ${videoLabel(video)}…`, async () => {
				const details = await this.#services.loadDetails(d.meta, video.id);
				d.streams = details.streams;
				d.videoId = video.id;
				d.mode = 'streams';
				d.cursor = 0;
			});
			return;
		}
		const option = d.streams[d.cursor];
		if (!option || streamKind(option.stream) === 'unsupported') return;
		if (streamKind(option.stream) === 'external') {
			await this.#run('Preparing service link…', async () => { this.message = await this.#services.openExternal(option.stream.externalUrl!); });
			return;
		}
		await this.#run('Opening video…', async () => {
			await this.#services.play(option, d.meta, d.videoId, (m) => this.progress(m));
			this.screen = 'player';
			this.#showOsd();
		});
	}

	// ---- player ----

	#pressInPlayer(button: Button): void {
		if (this.mediaMenu) {
			const menu = this.mediaMenu;
			if (button === 'b' || button === 'y') { this.mediaMenu = undefined; this.#showOsd(); return; }
			if (button === 'l' || button === 'r') { this.openTracks(menu.kind === 'audio' ? 'subtitles' : 'audio'); return; }
			if (button === 'up' || button === 'down') menu.cursor = Math.max(0, Math.min(this.trackRows().length - 1, menu.cursor + (button === 'up' ? -1 : 1)));
			if (button === 'a') void this.#selectTrack();
			if (menu.kind === 'subtitles' && (button === 'left' || button === 'right')) this.#services.subtitleDelay(button === 'left' ? -.5 : .5);
			this.#touch();
			return;
		}
		switch (button) {
			case 'y': return this.openTracks('subtitles');
			case 'a':
				this.#services.togglePause();
				return this.#showOsd();
			case 'left':
			case 'right':
				return this.#scrub(button === 'left' ? -1 : 1);
			case 'b':
				return this.stopPlayback();
			case 'up':
			case 'down':
				return this.#showOsd();
		}
	}

	/** Accelerating d-pad scrub: the target moves now, the seek happens once the presses stop. */
	#scrub(direction: 1 | -1): void {
		const p = this.#services.playback();
		if (!p) return;
		const now = this.#now();
		if (now - this.osd.lastScrubAt > SCRUB_COMMIT_MS) this.osd.scrubPresses = 0;
		const step = SCRUB_STEPS[Math.min(this.osd.scrubPresses, SCRUB_STEPS.length - 1)];
		const from = this.osd.scrubTarget ?? p.time;
		const max = p.duration > 0 ? p.duration - 1 : Number.POSITIVE_INFINITY;
		this.osd.scrubTarget = Math.max(0, Math.min(max, from + direction * step));
		this.osd.scrubPresses++;
		this.osd.lastScrubAt = now;
		this.osd.commitAt = now + SCRUB_COMMIT_MS;
		this.#showOsd();
	}

	#showOsd(): void {
		this.osd.visible = true;
		this.osd.hideAt = this.#now() + OSD_SHOW_MS;
		this.#touch();
	}

	// ---- helpers ----

	async #run(message: string, work: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.message = message;
		this.#touch();
		try {
			await work();
			if (this.message === message) this.message = '';
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.message = reason === 'cancelled' ? '' : `Failed: ${reason}`;
			if (this.message) this.#services.log(this.message);
		} finally {
			this.busy = false;
			this.#touch();
		}
	}

	#touch(): void {
		this.version++;
	}
}

function cardOf(meta: MetaPreview): Card {
	return { meta, label: meta.name };
}

/** Board rows: continue watching first (when there is any), then every catalog with a "See all" card. */
export function boardRows(continueWatching: MetaPreview[], catalogs: CatalogRow[]): Row[] {
	const rows: Row[] = [];
	if (continueWatching.length > 0) rows.push({ title: 'Continue watching', kind: 'posters', cards: continueWatching.map(cardOf) });
	for (const c of catalogs) {
		const cards = c.items.map(cardOf);
		if (c.ref) cards.push({ meta: { id: SEE_ALL_ID, type: c.type, name: 'See all' }, label: 'See all', seeAll: c.ref });
		rows.push({ title: `${c.name} · ${c.type}`, kind: 'posters', cards });
	}
	return rows;
}

/** A flat list as rows of `columns` cards (a grid). */
export function gridRows(items: MetaPreview[], columns: number): Row[] {
	const rows: Row[] = [];
	for (let i = 0; i < items.length; i += columns) rows.push({ title: '', kind: 'posters', cards: items.slice(i, i + columns).map(cardOf) });
	return rows;
}

export function videoLabel(v: Video): string {
	const se = v.season !== undefined && v.episode !== undefined ? `S${v.season}E${v.episode} ` : '';
	return `${se}${v.title ?? v.id}`;
}
