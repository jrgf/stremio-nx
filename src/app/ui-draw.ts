/**
 * Canvas rendering for the UI model, in Stremio's look: a left rail, rows
 * of 2:3 poster cards with the focused card raised, a details page over the
 * title's backdrop, and the player's on-screen display. Every interactive
 * element is recorded as a hit rectangle so taps can be resolved.
 */
import type { HitTarget, Playback, Section, UiModel, Row } from './ui';
import { SECTIONS as ALL_SECTIONS, SECTION_TITLES } from './ui';

export const W = 1280;
export const H = 720;
const RAIL_W = 88;
const CONTENT_X = 104;
const CONTENT_W = W - CONTENT_X - 16;
const FOOTER_H = 44;
const CARD_W = 150;
const CARD_H = 225;
const CARD_GAP = 14;
const CARDS_PER_ROW = 7;
const ROW_PITCH = 322;
const CHIPS_PITCH = 72;

const COLOR = {
	bg: '#0f0d1f',
	panel: '#1a1730',
	panelHi: '#241f44',
	accent: '#7b5bf5',
	accentDim: '#3b3272',
	text: '#ffffff',
	muted: '#a5a1c2',
	dim: '#6b6789',
	error: '#ff7b7b',
};

export interface HitRect {
	x: number;
	y: number;
	w: number;
	h: number;
	target: HitTarget;
}

export type ImageKind = 'poster' | 'backdrop' | 'logo';
export interface Drawable {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
}
export type ImageLookup = (url: string | undefined, kind: ImageKind) => Drawable | undefined;

/** The last recorded hit whose rectangle contains the point wins (drawn last = on top). */
export function hitTest(hits: HitRect[], x: number, y: number): HitTarget | undefined {
	for (let i = hits.length - 1; i >= 0; i--) {
		const r = hits[i];
		if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.target;
	}
	return undefined;
}

export function drawUi(ctx: CanvasRenderingContext2D, ui: UiModel, image: ImageLookup): HitRect[] {
	const hits: HitRect[] = [];
	ctx.fillStyle = COLOR.bg;
	ctx.fillRect(0, 0, W, H);
	if (ui.screen === 'details') drawDetails(ctx, ui, image, hits);
	else drawSection(ctx, ui, image, hits);
	drawFooter(ctx, ui);
	return hits;
}

// ---- section screen ----

function drawSection(ctx: CanvasRenderingContext2D, ui: UiModel, image: ImageLookup, hits: HitRect[]): void {
	drawRail(ctx, ui, hits);
	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 28px sans-serif';
	ctx.fillText(clip(ctx, ui.title(), CONTENT_W), CONTENT_X, 44);
	if (ui.section === 'addons') { drawAddons(ctx, ui, hits); return; }

	const s = ui.current();
	if (s.rows.length === 0) {
		if (!ui.busy) {
			ctx.fillStyle = COLOR.muted;
			ctx.font = '20px sans-serif';
			ctx.fillText(ui.section === 'search' ? 'Press Y to search.' : 'Nothing here.', CONTENT_X, 110);
		}
		return;
	}
	// Keep the focused row on screen: it becomes the second row once past the first.
	let first = Math.max(0, s.row - 1);
	if (s.rows[first]?.kind === 'chips' && first > 0) first = Math.max(0, first - 1);
	let y = 76;
	for (let r = first; r < s.rows.length && y < H - FOOTER_H; r++) {
		const row = s.rows[r];
		const focusedRow = !ui.railFocused && r === s.row;
		if (row.kind === 'chips') {
			drawChips(ctx, row, r, focusedRow ? s.col : -1, y, hits);
			y += CHIPS_PITCH;
		} else {
			drawPosterRow(ctx, row, r, focusedRow ? s.col : -1, y, image, hits);
			y += ROW_PITCH;
		}
	}
}

function drawRail(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	ctx.fillStyle = COLOR.panel;
	ctx.fillRect(0, 0, RAIL_W, H);
	ALL_SECTIONS.forEach((section: Section, i: number) => {
		const y = 96 + i * 104;
		const active = ui.section === section;
		const focused = ui.railFocused && ui.railIndex === i;
		if (focused || active) {
			ctx.fillStyle = focused ? COLOR.accent : COLOR.panelHi;
			roundRect(ctx, 16, y, 56, 56, 12);
		}
		drawRailIcon(ctx, section, 44, y + 28, focused || active ? COLOR.text : COLOR.dim);
		ctx.fillStyle = focused || active ? COLOR.text : COLOR.dim;
		ctx.font = '12px sans-serif';
		const label = SECTION_TITLES[section];
		ctx.fillText(label, 44 - ctx.measureText(label).width / 2, y + 74);
		hits.push({ x: 0, y: y - 8, w: RAIL_W, h: 96, target: { kind: 'rail', section } });
	});
}

function drawRailIcon(ctx: CanvasRenderingContext2D, section: Section, cx: number, cy: number, color: string): void {
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	switch (section) {
		case 'addons':
			ctx.strokeRect(cx - 11, cy - 11, 22, 22);
			ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
			ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5);
			ctx.stroke();
			return;
		case 'home':
			ctx.moveTo(cx - 12, cy + 2);
			ctx.lineTo(cx, cy - 10);
			ctx.lineTo(cx + 12, cy + 2);
			ctx.moveTo(cx - 8, cy);
			ctx.lineTo(cx - 8, cy + 11);
			ctx.lineTo(cx + 8, cy + 11);
			ctx.lineTo(cx + 8, cy);
			ctx.stroke();
			return;
		case 'discover':
			ctx.arc(cx, cy, 11, 0, Math.PI * 2);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(cx + 5, cy - 5);
			ctx.lineTo(cx + 2, cy + 2);
			ctx.lineTo(cx - 5, cy + 5);
			ctx.lineTo(cx - 2, cy - 2);
			ctx.closePath();
			ctx.fill();
			return;
		case 'library':
			for (let i = -1; i <= 1; i++) ctx.fillRect(cx - 11, cy - 9 + i * 8, 22, 4);
			return;
		case 'search':
			ctx.arc(cx - 3, cy - 3, 8, 0, Math.PI * 2);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(cx + 3, cy + 3);
			ctx.lineTo(cx + 11, cy + 11);
			ctx.stroke();
			return;
	}
}

function drawPosterRow(ctx: CanvasRenderingContext2D, row: Row, rowIndex: number, focusedCol: number, y: number, image: ImageLookup, hits: HitRect[]): void {
	let top = y;
	if (row.title) {
		ctx.fillStyle = COLOR.text;
		ctx.font = 'bold 22px sans-serif';
		ctx.fillText(clip(ctx, row.title, CONTENT_W - 120), CONTENT_X, y + 22);
		top = y + 46;
	}
	const n = row.cards.length;
	const anchor = focusedCol >= 0 ? focusedCol : 0;
	const first = Math.max(0, Math.min(anchor - 3, n - CARDS_PER_ROW));
	for (let i = first; i < Math.min(n, first + CARDS_PER_ROW); i++) {
		const card = row.cards[i];
		const x = CONTENT_X + (i - first) * (CARD_W + CARD_GAP);
		const focused = i === focusedCol;
		const scale = focused ? 1.08 : 1;
		const w = Math.round(CARD_W * scale);
		const h = Math.round(CARD_H * scale);
		const cx = x - Math.round((w - CARD_W) / 2);
		const cy = top - Math.round((h - CARD_H) / 2);
		if (focused) {
			ctx.fillStyle = COLOR.accent;
			roundRect(ctx, cx - 4, cy - 4, w + 8, h + 8, 10);
		}
		ctx.fillStyle = card.seeAll ? COLOR.panelHi : COLOR.panel;
		roundRect(ctx, cx, cy, w, h, 8);
		const img = card.seeAll ? undefined : image(card.meta.poster, 'poster');
		if (img && img.width > 0 && img.height > 0) {
			drawCover(ctx, img, cx, cy, w, h);
		} else {
			ctx.fillStyle = card.seeAll ? COLOR.text : COLOR.muted;
			ctx.font = card.seeAll ? 'bold 20px sans-serif' : '15px sans-serif';
			const lines = card.seeAll ? ['See all ›'] : wrap(ctx, card.meta.name, w - 20, 4);
			lines.forEach((line, li) => ctx.fillText(line, cx + (w - ctx.measureText(line).width) / 2, cy + h / 2 - (lines.length - 1) * 10 + li * 20));
		}
		if (card.meta.progress !== undefined && !card.seeAll) {
			ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
			ctx.fillRect(cx, cy + h - 8, w, 8);
			ctx.fillStyle = COLOR.accent;
			ctx.fillRect(cx, cy + h - 8, Math.round(w * card.meta.progress), 8);
		}
		ctx.fillStyle = focused ? COLOR.text : COLOR.muted;
		ctx.font = focused ? 'bold 16px sans-serif' : '16px sans-serif';
		ctx.fillText(clip(ctx, card.label, CARD_W), x, top + CARD_H + 26);
		hits.push({ x, y: top, w: CARD_W, h: CARD_H + 30, target: { kind: 'card', row: rowIndex, col: i } });
	}
	if (n > CARDS_PER_ROW) {
		ctx.fillStyle = COLOR.dim;
		ctx.font = '14px sans-serif';
		const pos = `${anchor + 1} / ${n}`;
		ctx.fillText(pos, CONTENT_X + CONTENT_W - ctx.measureText(pos).width, y + 22);
	}
}

function drawChips(ctx: CanvasRenderingContext2D, row: Row, rowIndex: number, focusedCol: number, y: number, hits: HitRect[]): void {
	ctx.font = '18px sans-serif';
	const widths = row.cards.map((c) => Math.round(ctx.measureText(c.label).width) + 32);
	let focusedRight = 0;
	let acc = 0;
	for (let i = 0; i <= Math.max(0, focusedCol); i++) {
		acc += widths[i] + 10;
		if (i === focusedCol) focusedRight = acc;
	}
	const offset = Math.max(0, focusedRight - CONTENT_W);
	let x = CONTENT_X - offset;
	row.cards.forEach((card, i) => {
		const w = widths[i];
		if (x + w > CONTENT_X && x < CONTENT_X + CONTENT_W) {
			const focused = i === focusedCol;
			ctx.fillStyle = focused ? COLOR.accent : COLOR.panel;
			roundRect(ctx, x, y + 12, w, 40, 20);
			ctx.fillStyle = focused ? COLOR.text : COLOR.muted;
			ctx.fillText(card.label, x + 16, y + 39);
			hits.push({ x, y: y + 12, w, h: 40, target: { kind: 'card', row: rowIndex, col: i } });
		}
		x += w + 10;
	});
}

// ---- details screen ----

function drawDetails(ctx: CanvasRenderingContext2D, ui: UiModel, image: ImageLookup, hits: HitRect[]): void {
	const d = ui.details;
	if (!d) return;
	const backdrop = image(d.meta.background, 'backdrop');
	if (backdrop && backdrop.width > 0) drawCover(ctx, backdrop, 0, 0, W, 400);
	ctx.fillStyle = 'rgba(15, 13, 31, 0.6)';
	ctx.fillRect(0, 0, W, 400);
	ctx.fillStyle = 'rgba(15, 13, 31, 0.85)';
	ctx.fillRect(0, 330, W, 70);

	// Back button.
	ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
	roundRect(ctx, 24, 20, 96, 36, 18);
	ctx.fillStyle = COLOR.text;
	ctx.font = '18px sans-serif';
	ctx.fillText('‹  Back', 44, 45);
	hits.push({ x: 16, y: 12, w: 112, h: 52, target: { kind: 'back' } });

	const logo = image(d.meta.logo, 'logo');
	if (logo && logo.width > 0 && logo.height > 0) {
		ctx.drawImage(logo.canvas, CONTENT_X, 90, logo.width, logo.height);
	} else {
		ctx.fillStyle = COLOR.text;
		ctx.font = 'bold 44px sans-serif';
		wrap(ctx, d.meta.name, 760, 2).forEach((line, i) => ctx.fillText(line, CONTENT_X, 130 + i * 50));
	}
	const imdb = d.meta.links?.find((l) => l.category === 'imdb')?.name;
	const metaLine = [d.meta.releaseInfo, d.meta.runtime, imdb ? `IMDb ${imdb}` : undefined, d.meta.type].filter(Boolean).join('  ·  ');
	ctx.fillStyle = COLOR.muted;
	ctx.font = '18px sans-serif';
	ctx.fillText(clip(ctx, metaLine, 760), CONTENT_X, 262);
	if (d.meta.description) {
		ctx.fillStyle = '#d6d3ea';
		ctx.font = '17px sans-serif';
		wrap(ctx, d.meta.description, 900, 3).forEach((line, i) => ctx.fillText(line, CONTENT_X, 294 + i * 23));
	}

	// The list: episodes or streams.
	const rows = ui.listRows();
	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 20px sans-serif';
	ctx.fillText(d.mode === 'episodes' ? 'Episodes' : 'Streams', CONTENT_X, 428);
	const ROW_H = 46;
	const top = 444;
	const visible = Math.floor((H - FOOTER_H - top) / ROW_H);
	const first = Math.max(0, Math.min(d.cursor - Math.floor(visible / 2), rows.length - visible));
	if (rows.length === 0 && !ui.busy) {
		ctx.fillStyle = COLOR.muted;
		ctx.font = '18px sans-serif';
		ctx.fillText('No streams from your addons for this title.', CONTENT_X, top + 30);
	}
	for (let i = first; i < Math.min(rows.length, first + visible); i++) {
		const y = top + (i - first) * ROW_H;
		const row = rows[i];
		const focused = i === d.cursor;
		if (focused) {
			ctx.fillStyle = row.enabled ? COLOR.accent : COLOR.accentDim;
			roundRect(ctx, CONTENT_X - 12, y, CONTENT_W + 4, ROW_H - 6, 8);
		}
		const detailW = row.detail ? 300 : 0;
		ctx.fillStyle = row.enabled ? COLOR.text : COLOR.dim;
		ctx.font = '20px sans-serif';
		ctx.fillText(clip(ctx, row.label, CONTENT_W - 40 - detailW), CONTENT_X, y + 28);
		if (row.detail) {
			ctx.fillStyle = focused ? '#e6e0ff' : COLOR.muted;
			ctx.font = '16px sans-serif';
			const text = clip(ctx, row.detail, detailW);
			ctx.fillText(text, CONTENT_X + CONTENT_W - 16 - ctx.measureText(text).width, y + 27);
		}
		hits.push({ x: CONTENT_X - 12, y, w: CONTENT_W + 4, h: ROW_H, target: { kind: 'listRow', index: i } });
	}
}

// ---- player on-screen display ----

export function drawOsd(ctx: CanvasRenderingContext2D, ui: UiModel, playback: Playback | null, hits: HitRect[]): void {
	hits.push({ x: 0, y: 0, w: W, h: H, target: { kind: 'video' } });
	if (!ui.osd.visible) return;
	ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
	ctx.fillRect(0, H - 130, W, 130);
	ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
	roundRect(ctx, 24, 20, 96, 36, 18);
	ctx.fillStyle = COLOR.text;
	ctx.font = '18px sans-serif';
	ctx.fillText('‹  Back', 44, 45);
	hits.push({ x: 16, y: 12, w: 112, h: 52, target: { kind: 'osdBack' } });
	ctx.font = '18px sans-serif';
	ctx.fillText('Audio', W - 246, 45);
	ctx.fillText('Subtitles (Y)', W - 150, 45);
	hits.push({ x: W - 270, y: 12, w: 110, h: 52, target: { kind: 'tracks', tab: 'audio' } });
	hits.push({ x: W - 160, y: 12, w: 152, h: 52, target: { kind: 'tracks', tab: 'subtitles' } });

	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 22px sans-serif';
	ctx.fillText(clip(ctx, ui.title(), 800), CONTENT_X + 56, H - 92);

	const time = playback?.time ?? 0;
	const duration = playback?.duration ?? 0;
	const target = ui.osd.scrubTarget;
	const shown = target ?? time;
	const timeText = `${fmtTime(shown)}${duration > 0 ? ` / ${fmtTime(duration)}` : ''}`;
	ctx.fillStyle = target !== undefined ? COLOR.accent : COLOR.muted;
	ctx.font = '18px sans-serif';
	ctx.fillText(timeText, CONTENT_X + CONTENT_W - ctx.measureText(timeText).width, H - 92);

	// Play/pause control.
	const bx = CONTENT_X;
	const by = H - 112;
	ctx.fillStyle = COLOR.text;
	if (playback?.paused) {
		ctx.beginPath();
		ctx.moveTo(bx + 6, by + 2);
		ctx.lineTo(bx + 28, by + 14);
		ctx.lineTo(bx + 6, by + 26);
		ctx.closePath();
		ctx.fill();
	} else {
		ctx.fillRect(bx + 6, by + 2, 7, 24);
		ctx.fillRect(bx + 19, by + 2, 7, 24);
	}
	hits.push({ x: bx - 12, y: by - 12, w: 56, h: 52, target: { kind: 'osdPause' } });

	// Progress bar.
	const barX = CONTENT_X;
	const barW = CONTENT_W;
	const barY = H - 60;
	ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
	roundRect(ctx, barX, barY, barW, 8, 4);
	if (duration > 0) {
		ctx.fillStyle = COLOR.accent;
		roundRect(ctx, barX, barY, Math.max(8, Math.round((Math.min(time, duration) / duration) * barW)), 8, 4);
		if (target !== undefined) {
			const tx = barX + Math.round((Math.min(target, duration) / duration) * barW);
			ctx.fillStyle = COLOR.text;
			ctx.fillRect(tx - 2, barY - 8, 4, 24);
			const delta = target - time;
			const label = `${delta >= 0 ? '+' : '−'}${fmtTime(Math.abs(delta))}`;
			ctx.font = 'bold 16px sans-serif';
			ctx.fillText(label, Math.min(W - 80, Math.max(CONTENT_X, tx - ctx.measureText(label).width / 2)), barY - 14);
		}
	}
	// A generous strip around the bar takes seek taps.
	for (let i = 0; i < 40; i++) {
		hits.push({ x: barX + (i * barW) / 40, y: barY - 24, w: barW / 40, h: 56, target: { kind: 'osdSeek', fraction: (i + 0.5) / 40 } });
	}
	if (playback?.buffering) {
		ctx.fillStyle = COLOR.accent;
		ctx.font = 'bold 16px sans-serif';
		ctx.fillText(`Buffering… ${(playback.aheadMiB ?? 0).toFixed(1)} MiB ready`, CONTENT_X + 56, H - 20);
	} else if (playback?.paused) {
		ctx.fillStyle = COLOR.muted;
		ctx.font = '16px sans-serif';
		ctx.fillText('Paused', CONTENT_X + 56, H - 20);
	}
	if (ui.mediaMenu) drawTracks(ctx, ui, hits);
}

function drawAddons(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	const setup = ui.addonSetup();
	ctx.font = '20px sans-serif';
	ctx.fillStyle = COLOR.muted;
	ctx.fillText('Install directly with Y, or use a phone/computer on the same Wi-Fi:', CONTENT_X, 94);
	ctx.fillStyle = COLOR.text;
	ctx.font = 'bold 24px sans-serif';
	ctx.fillText(setup.url, CONTENT_X, 134);
	ctx.fillText(`Pairing code: ${setup.code}`, CONTENT_X, 171);
	ctx.font = '18px sans-serif';
	ctx.fillStyle = COLOR.muted;
	ctx.fillText('Configure the add-on on its website, then paste its install link into the setup page.', CONTENT_X, 208);
	ctx.fillStyle = COLOR.accent;
	roundRect(ctx, W - 256, 118, 228, 55, 10);
	ctx.fillStyle = COLOR.text;
	ctx.fillText('Y  Install from link', W - 232, 152);
	hits.push({ x: W - 256, y: 118, w: 228, h: 55, target: { kind: 'addonInstall' } });
	const addons = ui.addons(), first = Math.max(0, ui.addonCursor - 4);
	if (!addons.length) ctx.fillText('No installed add-ons.', CONTENT_X, 282);
	for (let i = first; i < Math.min(addons.length, first + 6); i++) {
		const addon = addons[i], y = 242 + (i - first) * 66;
		ctx.fillStyle = !ui.railFocused && i === ui.addonCursor ? COLOR.accentDim : COLOR.panel;
		roundRect(ctx, CONTENT_X, y, CONTENT_W, 58, 8);
		ctx.fillStyle = COLOR.text; ctx.font = '20px sans-serif';
		ctx.fillText(clip(ctx, addon.manifest.name, CONTENT_W - 220), CONTENT_X + 16, y + 25);
		ctx.fillStyle = COLOR.muted; ctx.font = '15px sans-serif';
		ctx.fillText(clip(ctx, `${addon.manifest.version} · ${addon.manifest.id}`, CONTENT_W - 220), CONTENT_X + 16, y + 46);
		ctx.fillText(addon.flags?.protected ? 'Built-in' : ui.addonConfirm === addon.transportUrl ? 'A confirm removal' : 'A remove', W - 196, y + 34);
		hits.push({ x: CONTENT_X, y, w: CONTENT_W, h: 58, target: { kind: 'addonRow', index: i } });
	}
}

function drawTracks(ctx: CanvasRenderingContext2D, ui: UiModel, hits: HitRect[]): void {
	const menu = ui.mediaMenu!;
	ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(0, 0, W, H);
	ctx.fillStyle = COLOR.panel; roundRect(ctx, 180, 76, 920, 568, 16);
	for (const [tab, label, x] of [['audio', 'Audio', 212], ['subtitles', 'Subtitles', 462]] as const) {
		ctx.fillStyle = menu.kind === tab ? COLOR.accent : COLOR.panelHi;
		roundRect(ctx, x, 94, 232, 48, 8);
		ctx.font = 'bold 22px sans-serif'; ctx.fillStyle = COLOR.text; ctx.fillText(label, x + 20, 125);
		hits.push({ x, y: 94, w: 232, h: 48, target: { kind: 'tracks', tab } });
	}
	ctx.font = '18px sans-serif'; ctx.fillText('B  Close', 974, 125);
	hits.push({ x: 946, y: 94, w: 134, h: 48, target: { kind: 'closeTracks' } });
	const rows = ui.trackRows(), first = Math.max(0, menu.cursor - 6);
	if (!rows.length) { ctx.fillStyle = COLOR.muted; ctx.fillText('No audio tracks available.', 212, 196); }
	for (let i = first; i < Math.min(rows.length, first + 8); i++) {
		const row = rows[i], y = 156 + (i - first) * 43;
		ctx.fillStyle = i === menu.cursor ? COLOR.accentDim : COLOR.panel;
		roundRect(ctx, 202, y, 876, 40, 6);
		ctx.fillStyle = row.enabled ? COLOR.text : COLOR.dim; ctx.font = '19px sans-serif';
		ctx.fillText(clip(ctx, `${row.selected ? '✓ ' : ''}${row.label}`, 840), 216, y + 27);
		hits.push({ x: 202, y, w: 876, h: 40, target: { kind: 'trackRow', index: i } });
	}
	if (menu.kind === 'subtitles') {
		ctx.fillStyle = COLOR.text; ctx.font = '19px sans-serif';
		const delay = ui.subtitleDelay();
		ctx.fillText(`Subtitle delay: ${delay >= 0 ? '+' : ''}${delay.toFixed(1)} s`, 260, 548);
		ctx.fillText('−', 222, 548); ctx.fillText('+', 612, 548);
		hits.push({ x: 202, y: 514, w: 52, h: 50, target: { kind: 'subtitleDelay', delta: -.5 } });
		hits.push({ x: 592, y: 514, w: 52, h: 50, target: { kind: 'subtitleDelay', delta: .5 } });
	}
	ctx.fillStyle = COLOR.muted; ctx.font = '17px sans-serif';
	ctx.fillText(clip(ctx, ui.trackBusy ? 'Loading track…' : ui.trackNotice(), 862), 212, 586);
	ctx.fillText('L/R tabs   ↑↓ choose   A select   ◀▶ subtitle delay   B close', 212, 622);
}

export function drawSubtitles(ctx: CanvasRenderingContext2D, text: string, raised: boolean): void {
	if (!text) return;
	ctx.font = '28px sans-serif';
	const lines = text.split('\n').flatMap(line => wrap(ctx, line, W - 160, 4)).slice(0, 4);
	const bottom = raised ? H - 166 : H - 48;
	for (let i = 0; i < lines.length; i++) {
		const width = ctx.measureText(lines[i]).width, y = bottom - (lines.length - 1 - i) * 35;
		ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.fillRect((W - width) / 2 - 8, y - 28, width + 16, 35);
		ctx.fillStyle = COLOR.text; ctx.fillText(lines[i], (W - width) / 2, y);
	}
}

// ---- footer + helpers ----

function drawFooter(ctx: CanvasRenderingContext2D, ui: UiModel): void {
	ctx.fillStyle = COLOR.panel;
	ctx.fillRect(RAIL_W, H - FOOTER_H, W - RAIL_W, FOOTER_H);
	ctx.fillStyle = ui.message.startsWith('Failed') ? COLOR.error : COLOR.muted;
	ctx.font = '17px sans-serif';
	ctx.fillText(clip(ctx, ui.message || ui.hint(), CONTENT_W), CONTENT_X, H - 16);
}

function drawCover(ctx: CanvasRenderingContext2D, img: Drawable, x: number, y: number, w: number, h: number): void {
	// Scale to cover the box, cropping the overflow, centered.
	const scale = Math.max(w / img.width, h / img.height);
	const sw = Math.round(w / scale);
	const sh = Math.round(h / scale);
	const sx = Math.round((img.width - sw) / 2);
	const sy = Math.round((img.height - sh) / 2);
	ctx.drawImage(img.canvas, sx, sy, sw, sh, x, y, w, h);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.lineTo(x + w - rr, y);
	ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
	ctx.lineTo(x + w, y + h - rr);
	ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
	ctx.lineTo(x + rr, y + h);
	ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
	ctx.lineTo(x, y + rr);
	ctx.arc(x + rr, y + rr, rr, Math.PI, (3 * Math.PI) / 2);
	ctx.closePath();
	ctx.fill();
}

export function fmtTime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Greedy word wrap into at most `maxLines` lines; the last line is clipped with an ellipsis. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, ' ').trim().split(' ');
	const lines: string[] = [];
	let line = '';
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (ctx.measureText(candidate).width <= maxWidth || !line) {
			line = candidate;
			continue;
		}
		lines.push(line);
		line = word;
		if (lines.length === maxLines) return lines.slice(0, maxLines - 1).concat(clip(ctx, `${lines[maxLines - 1]} ${word}`, maxWidth));
	}
	if (line) lines.push(line);
	return lines.slice(0, maxLines).map((l, i, arr) => (i === arr.length - 1 ? clip(ctx, l, maxWidth) : l));
}

export function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
		else hi = mid - 1;
	}
	return `${text.slice(0, lo)}…`;
}
