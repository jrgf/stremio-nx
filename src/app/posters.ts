/**
 * Poster, backdrop and logo images for the UI as small thumbnails. Addon
 * posters can be full-size IMDb images (24 MB decoded each); the runtime
 * decodes at native size, so each image is fetched, decoded, drawn into an
 * offscreen canvas at display size and the full decode is closed at once.
 * Only the thumbnails stay cached (an LRU by count; ~200 KB per poster).
 */
export type ImageKind = 'poster' | 'backdrop' | 'logo';

export interface Thumbnail {
	canvas: OffscreenCanvas;
	width: number;
	height: number;
}

type Entry = { state: 'loading' | 'ready' | 'failed'; thumb?: Thumbnail };

const MAX_CONCURRENT = 2;
const SIZE: Record<ImageKind, { w: number; h: number; cover: boolean }> = {
	poster: { w: 180, h: 270, cover: true },
	backdrop: { w: 1280, h: 400, cover: true },
	logo: { w: 420, h: 140, cover: false },
};

export class ThumbnailCache {
	#entries = new Map<string, Entry>();
	#queue: { url: string; kind: ImageKind }[] = [];
	#inflight = 0;
	#onChange: () => void;
	#max: number;

	constructor(onChange: () => void, max = 200) {
		this.#onChange = onChange;
		this.#max = max;
	}

	get(url: string | undefined, kind: ImageKind): Thumbnail | undefined {
		if (!url) return undefined;
		const key = `${kind}:${url}`;
		const entry = this.#entries.get(key);
		if (entry) {
			this.#entries.delete(key); // refresh recency
			this.#entries.set(key, entry);
			return entry.state === 'ready' ? entry.thumb : undefined;
		}
		this.#entries.set(key, { state: 'loading' });
		this.#queue.push({ url, kind });
		this.#pump();
		this.#evict();
		return undefined;
	}

	#pump(): void {
		while (this.#inflight < MAX_CONCURRENT && this.#queue.length > 0) {
			const { url, kind } = this.#queue.shift()!;
			const key = `${kind}:${url}`;
			if (!this.#entries.has(key)) continue; // evicted before it started
			this.#inflight++;
			void this.#load(url, kind).then(
				(thumb) => this.#done(key, thumb),
				() => this.#done(key, undefined),
			);
		}
	}

	async #load(url: string, kind: ImageKind): Promise<Thumbnail> {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`image ${res.status}`);
		const bitmap = await createImageBitmap(await res.blob());
		try {
			const box = SIZE[kind];
			const scale = box.cover ? Math.max(box.w / bitmap.width, box.h / bitmap.height) : Math.min(box.w / bitmap.width, box.h / bitmap.height, 1.5);
			const w = box.cover ? box.w : Math.max(1, Math.round(bitmap.width * scale));
			const h = box.cover ? box.h : Math.max(1, Math.round(bitmap.height * scale));
			const canvas = new OffscreenCanvas(w, h);
			const ctx = canvas.getContext('2d')!;
			if (box.cover) {
				const sw = Math.round(w / scale);
				const sh = Math.round(h / scale);
				ctx.drawImage(bitmap, Math.round((bitmap.width - sw) / 2), Math.round((bitmap.height - sh) / 2), sw, sh, 0, 0, w, h);
			} else {
				ctx.drawImage(bitmap, 0, 0, w, h);
			}
			return { canvas, width: w, height: h };
		} finally {
			bitmap.close(); // the full-size decode goes now, not at the next GC
		}
	}

	#done(key: string, thumb: Thumbnail | undefined): void {
		this.#inflight--;
		const entry = this.#entries.get(key);
		if (entry) {
			entry.state = thumb ? 'ready' : 'failed';
			entry.thumb = thumb;
		}
		this.#onChange();
		this.#pump();
	}

	#evict(): void {
		while (this.#entries.size > this.#max) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}
}
