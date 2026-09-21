/**
 * Host tests for the UI model with fake services: board rows and the rail,
 * card navigation, discover chips, search through the keyboard prompt,
 * details -> streams -> player, series episodes, scrubbing, and touch hooks.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogRef, CatalogRow, MetaDetails, MetaItem, MetaPreview, StreamOption } from '../src/stremio/client';
import { UiModel, boardRows, gridRows, type Playback, type UiServices } from '../src/app/ui';

const cinemeta: CatalogRef = { addonName: 'Cinemeta', addonUrl: 'http://cm/manifest.json', type: 'movie', id: 'top', name: 'Popular' };
const pd: CatalogRef = { addonName: 'PD', addonUrl: 'http://pd/manifest.json', type: 'movie', id: 'pd', name: 'Public Domain' };
const item = (id: string, type = 'movie'): MetaPreview => ({ id, name: `Title ${id}`, type, poster: `http://img/${id}` });
const torrent: StreamOption = { addonName: 'PD', addonUrl: pd.addonUrl, stream: { name: '720p', infoHash: 'ab'.repeat(20), fileIdx: 0 } };
const web: StreamOption = { addonName: 'Hub', addonUrl: 'http://hub', stream: { name: 'Web', url: 'http://x' } };

function fake(calls: string[], overrides: Partial<UiServices> = {}) {
	let now = 1000;
	let playback: Playback | null = null;
	const services: UiServices = {
		addons: () => [], installAddon: async () => {}, removeAddon: async () => {}, addonSetup: () => ({ url: 'http://switch:11471', code: 'ABCD1234' }),
		openExternal: async url => { calls.push(`external ${url}`); return 'Open the phone setup page.'; },
		tracks: () => [], selectTrack: async () => {}, subtitleDelay: () => 0, trackNotice: () => '',
		catalogs: () => [cinemeta, pd],
		loadBoard: async () => {
			calls.push('board');
			const rows: CatalogRow[] = [
				{ id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item('m1'), item('m2'), item('m3')], ref: cinemeta },
				{ id: 'pd', type: 'movie', name: 'Public Domain', addonName: 'PD', addonId: 'pd', items: [item('p1'), item('s1', 'series')], ref: pd },
			];
			return rows;
		},
		continueWatching: () => [{ ...item('cw1'), progress: 0.4 }],
		loadCatalog: async (c) => { calls.push(`catalog ${c.id}`); return Array.from({ length: 9 }, (_, i) => item(`${c.id}${i}`)); },
		loadLibrary: async () => { calls.push('library'); return []; },
		search: async (q) => { calls.push(`search ${q}`); return [{ id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item('r1')], ref: cinemeta }]; },
		promptText: async () => 'zombie',
		loadDetails: async (it, videoId) => {
			calls.push(`details ${it.id}${videoId ? `/${videoId}` : ''}`);
			const meta: MetaItem = it.type === 'series'
				? { ...it, videos: [{ id: `${it.id}:1:1`, title: 'Pilot', season: 1, episode: 1 }, { id: `${it.id}:1:2`, title: 'Two', season: 1, episode: 2 }] }
				: { ...it, description: 'A film.' };
			const details: MetaDetails = { meta, streams: [web, torrent] };
			return details;
		},
		play: async (option, meta, videoId, onProgress) => { onProgress('connecting'); calls.push(`play ${meta.id}/${videoId} ${option.stream.infoHash?.slice(0, 4)}`); playback = { time: 100, duration: 5000, paused: false }; },
		stop: () => { calls.push('stop'); playback = null; },
		togglePause: () => { calls.push('pause'); if (playback) playback.paused = !playback.paused; },
		seekTo: (s) => calls.push(`seekTo ${s}`),
		playback: () => playback,
		log: () => {},
		...overrides,
	};
	const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
	return { services, clock };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('URL sources play and external service links hand off without entering the player', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services); await settle();
	ui.press('a'); await settle();
	assert.equal(ui.listRows()[0].detail, 'HTTP video · Hub');
	ui.press('a'); await settle(); assert.equal(ui.screen, 'player');
	assert.ok(calls.some(c => c.startsWith('play cw1/')));
	ui.stopPlayback();
	ui.details!.streams = [{ ...web, stream: { externalUrl: 'https://provider.example/watch', name: 'WatchHub' } }, { ...web, stream: { url: 'javascript:bad' } }];
	ui.details!.cursor = 0;
	assert.deepEqual(ui.listRows().map(r => r.enabled), [true, false]);
	ui.press('a'); await settle(); assert.equal(ui.screen, 'details');
	assert.ok(calls.includes('external https://provider.example/watch'));
	assert.match(ui.message, /phone setup/);
});

test('controller and touch track menus keep playback running and support subtitle delay', async () => {
	const calls: string[] = [];
	let delay = 0;
	const { services, clock } = fake(calls, {
		tracks: kind => kind === 'audio' ? [{ id: '2', label: 'Spanish', selected: true, enabled: true }] : [
			{ id: 'off', label: 'Off', selected: true, enabled: true }, { id: 'embedded:3', label: 'English', selected: false, enabled: true },
			{ id: 'embedded:4', label: 'Bitmap', selected: false, enabled: false }],
		selectTrack: async (kind, id) => { calls.push(`${kind}:${id}`); },
		subtitleDelay: delta => { if (delta !== undefined) delay += delta; return delay; },
		playback: () => ({ time: 20, duration: 100, paused: false }),
	});
	const ui = new UiModel(services, clock.now); await settle(); ui.screen = 'player';
	ui.press('y'); assert.equal(ui.mediaMenu?.kind, 'subtitles');
	clock.advance(5000); ui.tick(clock.now()); assert.equal(ui.osd.visible, true);
	ui.press('down'); ui.press('a'); await settle(); assert.ok(calls.includes('subtitles:embedded:3'));
	ui.press('right'); assert.equal(delay, .5); assert.ok(!calls.some(c => c.startsWith('seekTo')));
	ui.tap({ kind: 'subtitleDelay', delta: -.5 }); assert.equal(delay, 0);
	ui.press('down'); ui.press('a'); await settle(); assert.ok(!calls.includes('subtitles:embedded:4'));
	ui.press('l'); assert.equal(ui.mediaMenu?.kind, 'audio');
	ui.tap({ kind: 'trackRow', index: 0 }); await settle(); assert.ok(calls.includes('audio:2'));
	ui.press('b'); assert.equal(ui.mediaMenu, undefined); assert.equal(ui.screen, 'player'); assert.ok(!calls.includes('stop'));
	ui.press('b'); assert.ok(calls.includes('stop'));
});

test('add-on screen installs links, refreshes catalogs and confirms removal', async () => {
	const calls: string[] = [];
	let addons = [{ transportUrl: 'https://example.com/manifest.json', manifest: { id: 'sample', name: 'Sample', version: '1.0.0', types: [], resources: [], catalogs: [] } }];
	const { services } = fake(calls, { addons: () => addons, promptText: async () => 'stremio://example.com/manifest.json',
		installAddon: async url => { calls.push(`install ${url}`); }, removeAddon: async url => { calls.push(`remove ${url}`); addons = []; } });
	const ui = new UiModel(services); await settle();
	ui.tap({ kind: 'rail', section: 'addons' });
	assert.equal(ui.section, 'addons'); assert.equal(ui.addonSetup().code, 'ABCD1234');
	ui.press('y'); await settle(); assert.ok(calls.includes('install stremio://example.com/manifest.json')); assert.equal(ui.sections.home.loaded, false);
	ui.press('a'); assert.ok(ui.addonConfirm); assert.ok(!calls.some(c => c.startsWith('remove')));
	ui.press('b'); assert.equal(ui.addonConfirm, undefined);
	ui.tap({ kind: 'addonRow', index: 0 }); ui.press('a'); await settle(); assert.equal(ui.addons().length, 0);
	assert.ok(calls.includes('remove https://example.com/manifest.json'));
});

test('default UI clock matches render ticks for OSD hiding and scrub commits', async () => {
	const calls: string[] = [];
	const { services } = fake(calls, { playback: () => ({ time: 100, duration: 5000, paused: false }) });
	const ui = new UiModel(services);
	await settle();
	ui.screen = 'player';
	ui.press('up');
	ui.tick(performance.now() + 4001);
	assert.equal(ui.osd.visible, false);
	ui.press('right');
	ui.tick(performance.now() + 451);
	assert.equal(calls.at(-1), 'seekTo 110');
	assert.equal(ui.osd.scrubTarget, undefined);
});

test('board rows: continue watching first, catalogs with a "See all" card', async () => {
	const rows = boardRows([{ ...item('cw'), progress: 0.5 }], [{ id: 'top', type: 'movie', name: 'Popular', addonName: 'Cinemeta', addonId: 'cm', items: [item('a')], ref: cinemeta }]);
	assert.deepEqual(rows.map((r) => r.title), ['Continue watching', 'Popular · movie']);
	assert.equal(rows[1].cards.at(-1)?.seeAll, cinemeta);
	assert.equal(gridRows(Array.from({ length: 15 }, (_, i) => item(String(i))), 7).length, 3);
});

test('home: navigate cards and rows, open details, play, scrub and stop', async () => {
	const calls: string[] = [];
	const { services, clock } = fake(calls);
	const ui = new UiModel(services, clock.now);
	await settle();
	assert.equal(ui.screen, 'section');
	assert.deepEqual(ui.current().rows.map((r) => r.title), ['Continue watching', 'Popular · movie', 'Public Domain · movie']);

	ui.press('down');
	ui.press('right');
	assert.equal(ui.focusedCard()?.meta.id, 'm2');
	ui.press('a');
	await settle();
	assert.equal(ui.screen, 'details');
	assert.equal(ui.details?.mode, 'streams');
	assert.deepEqual(ui.listRows().map((r) => r.enabled), [true, true]);
	ui.press('down');
	ui.press('a');
	await settle();
	assert.equal(ui.screen, 'player');
	assert.equal(ui.osd.visible, true);
	assert.deepEqual(calls.filter((c) => c.startsWith('play')), ['play m2/m2 abab']);

	// Scrub: two 10 s steps within the commit window, committed once presses stop.
	ui.press('right');
	ui.press('right');
	assert.equal(ui.osd.scrubTarget, 120);
	clock.advance(500);
	ui.tick(clock.now());
	assert.equal(calls.at(-1), 'seekTo 120');
	assert.equal(ui.osd.scrubTarget, undefined);

	ui.press('a');
	assert.equal(calls.at(-1), 'pause');
	ui.press('b');
	assert.equal(ui.screen, 'details');
	assert.equal(calls.at(-1), 'stop');
	ui.press('b');
	assert.equal(ui.screen, 'section');
});

test('rail: left from the first card focuses it; A switches section; L/R cycle', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.press('left');
	assert.equal(ui.railFocused, true);
	ui.press('down');
	ui.press('down');
	ui.press('a');
	await settle();
	assert.equal(ui.section, 'library');
	assert.ok(calls.includes('library'));
	assert.match(ui.message, /empty/);
	ui.press('r');
	await settle();
	assert.equal(ui.section, 'search');
	assert.ok(calls.includes('search zombie'));
	assert.equal(ui.current().rows[0].cards[0].meta.id, 'r1');
});

test('discover: chips row, opening a catalog builds a grid; "See all" jumps there', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.press('r');
	await settle();
	assert.equal(ui.section, 'discover');
	assert.equal(ui.current().rows[0].kind, 'chips');
	ui.press('right');
	ui.press('a');
	await settle();
	assert.ok(calls.includes('catalog pd'));
	assert.equal(ui.current().rows.length, 1 + 2); // chips + 9 items in rows of 7
	assert.equal(ui.current().row, 1);
	// Back to home, "See all" on the Popular row.
	ui.press('l');
	await settle();
	ui.press('down');
	for (let i = 0; i < 5; i++) ui.press('right');
	assert.equal(ui.focusedCard()?.label, 'See all');
	ui.press('a');
	await settle();
	assert.equal(ui.section, 'discover');
	assert.ok(calls.includes('catalog top'));
});

test('series: episodes list first, then streams for the chosen episode', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.press('down');
	ui.press('down');
	ui.press('right');
	assert.equal(ui.focusedCard()?.meta.id, 's1');
	ui.press('a');
	await settle();
	assert.equal(ui.details?.mode, 'episodes');
	ui.press('down');
	ui.press('a');
	await settle();
	assert.equal(ui.details?.mode, 'streams');
	assert.equal(calls.at(-1), 'details s1/s1:1:2');
	ui.press('b');
	assert.equal(ui.details?.mode, 'episodes');
	assert.equal(ui.details?.cursor, 1);
});

test('touch: tapping a card opens it, tapping the rail switches, seek taps and swipes', async () => {
	const calls: string[] = [];
	const { services } = fake(calls);
	const ui = new UiModel(services);
	await settle();
	ui.swipe(2, 0);
	assert.equal(ui.current().col, 0); // continue-watching row has one card
	ui.swipe(0, 1);
	ui.swipe(2, 0);
	assert.equal(ui.focusedCard()?.meta.id, 'm3');
	ui.tap({ kind: 'card', row: 1, col: 0 });
	await settle();
	assert.equal(ui.screen, 'details');
	assert.equal(calls.at(-1), 'details m1');
	ui.tap({ kind: 'listRow', index: 1 });
	await settle();
	assert.equal(ui.screen, 'player');
	ui.tap({ kind: 'osdSeek', fraction: 0.5 });
	assert.equal(calls.at(-1), 'seekTo 2500');
	ui.tap({ kind: 'osdBack' });
	assert.equal(ui.screen, 'details');
	ui.tap({ kind: 'back' });
	assert.equal(ui.screen, 'section');
	ui.tap({ kind: 'rail', section: 'library' });
	await settle();
	assert.equal(ui.section, 'library');
});

test('a dismissed search prompt and a failed load leave a message, not a crash', async () => {
	const calls: string[] = [];
	const { services } = fake(calls, { promptText: async () => null, loadBoard: async () => { throw new Error('offline'); } });
	const ui = new UiModel(services);
	await settle();
	assert.equal(ui.message, 'Failed: offline');
	ui.press('l'); // wraps to add-ons
	ui.press('l'); // search
	await settle();
	assert.equal(ui.section, 'search');
	assert.equal(ui.message, 'Press Y to search.');
	assert.equal(ui.busy, false);
});
