import { fetchTextLimited, type Addon } from './addons';

export interface SubtitleOption { id: string; label: string; language: string; url: string }
export interface Cue { start: number; end: number; text: string; latestEnd: number }

export function plainSubtitle(text: string): string {
	return text.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '')
		.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ')
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key] ?? '')
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, 4096);
}

function timestamp(value: string): number {
	const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{2,3})$/.exec(value.trim());
	if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return NaN;
	return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number('0.' + match[4]);
}

/** SRT, WebVTT and the text/timing portion of ASS/SSA; styling is rendered consistently by the player. */
export function parseSubtitles(source: string): Cue[] {
	if (source.length > 2 * 1024 * 1024) throw new Error('Subtitle file is too large.');
	const cues: Cue[] = [];
	const lines = source.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
	const add = (start: number, end: number, text: string) => {
		text = plainSubtitle(text);
		if (text && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
			if (cues.length >= 20000) throw new Error('Subtitle file has too many cues.');
			cues.push({ start, end, text, latestEnd: 0 });
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^Dialogue:\s*/i.test(line)) {
			const fields = line.replace(/^Dialogue:\s*/i, '').split(',');
			if (fields.length >= 10) add(timestamp(fields[1]), timestamp(fields[2]), fields.slice(9).join(','));
			continue;
		}
		const match = /^(\S+)\s+-->\s+(\S+)/.exec(line.trim());
		if (!match) continue;
		const text: string[] = [];
		while (i + 1 < lines.length && lines[i + 1].trim()) text.push(lines[++i]);
		add(timestamp(match[1]), timestamp(match[2]), text.join('\n'));
	}
	if (!cues.length) throw new Error('No text subtitles found. Use an SRT, WebVTT or ASS subtitle file.');
	cues.sort((a, b) => a.start - b.start);
	let latestEnd = 0;
	for (const cue of cues) cue.latestEnd = latestEnd = Math.max(latestEnd, cue.end);
	return cues;
}

/** Binary search works after seeks in either direction, including overlapping cues. */
export function subtitleTextAt(cues: Cue[], seconds: number): string {
	if (!Number.isFinite(seconds)) return '';
	let lo = 0, hi = cues.length;
	while (lo < hi) { const mid = (lo + hi) >>> 1; if (cues[mid].start <= seconds) lo = mid + 1; else hi = mid; }
	const active: string[] = [];
	let length = 0;
	for (let i = lo - 1; i >= 0 && cues[i].latestEnd > seconds && length < 4096; i--) {
		if (cues[i].end > seconds) { active.push(cues[i].text); length += cues[i].text.length; }
	}
	return active.reverse().join('\n').slice(0, 4096);
}

export async function findSubtitles(addons: Addon[], type: string, id: string, filename: string, videoSize: number, signal?: AbortSignal): Promise<{ tracks: SubtitleOption[]; failed: number }> {
	const tracks: SubtitleOption[] = [];
	let failed = 0;
	const supported = addons.filter(a => a.manifest.resources.some(resource => {
		const r = typeof resource === 'string' ? { name: resource } : resource;
		const types = r.types ?? a.manifest.types, prefixes = r.idPrefixes ?? a.manifest.idPrefixes;
		return r.name === 'subtitles' && types.includes(type) && (!prefixes || prefixes.some(prefix => id.startsWith(prefix)));
	}));
	// Keep request concurrency and aggregate results bounded on the Switch.
	for (let i = 0; i < supported.length && tracks.length < 500; i += 3) {
		if (signal?.aborted) break;
		await Promise.all(supported.slice(i, i + 3).map(async addon => {
			try {
				const url = new URL(addon.transportUrl);
				const extra = `filename=${encodeURIComponent(filename)}&videoSize=${videoSize}`;
				url.pathname = url.pathname.replace(/manifest\.json$/, '') + `subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}/${extra}.json`;
				const body = JSON.parse(await fetchTextLimited(url.href, 512 * 1024, signal)) as { subtitles?: unknown };
				if (!Array.isArray(body.subtitles)) throw new Error('Invalid subtitle response');
				for (const raw of body.subtitles.slice(0, 200)) {
					if (!raw || typeof raw.id !== 'string' || typeof raw.url !== 'string' || typeof raw.lang !== 'string') continue;
					const src = new URL(raw.url, url);
					if (!['https:', 'http:'].includes(src.protocol) || src.username || src.password || tracks.length >= 500) continue;
					tracks.push({ id: `${addon.transportUrl}|${raw.id}`, url: src.href, language: raw.lang.slice(0, 64), label: `${String(raw.label ?? raw.lang).slice(0, 160)} · ${addon.manifest.name}` });
				}
			} catch { if (!signal?.aborted) failed++; }
		}));
	}
	return { tracks, failed };
}
