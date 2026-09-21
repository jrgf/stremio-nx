declare module '*.wasm' {
	const bytes: Uint8Array;
	export default bytes;
}

declare module '@stremio/stremio-core-web/stremio_core_web.js' {
	export default function init(opts: { module_or_path: BufferSource }): Promise<unknown>;
	export function initialize_runtime(emit: (event: any) => void): Promise<void>;
	export function dispatch(action: unknown, field: unknown, locationHash: unknown): void;
	export function get_state(field: unknown): unknown;
}

// Local augmentation for the patched runtime's MediaSource (in the fork at
// runtime/nxjs, not yet in the published @nx.js/runtime types). See
// scripts/build-runtime.sh.
declare namespace Switch {
	class MediaSource {
		constructor(size: number);
		readonly url: string;
		readonly wanted: number;
		readonly position: number;
		buffered(offset: number): number;
		provide(offset: number, data: BufferSource): void;
		discardBefore(offset: number): void;
		retain(start: number, end: number, prefixEnd?: number): void;
		readonly storedBytes: number;
		close(): void;
	}
}

interface VideoMediaTrack {
	id: number;
	language: string;
	label: string;
	codec: string;
	supported: boolean;
}
interface Video {
	setRenderSize(maxWidth: number, maxHeight: number): void;
	getFrameStats(): { width: number; height: number; transferMs: number; convertMs: number };
	readonly decoder: 'software' | 'nvdec-pending' | 'nvdec';
	readonly audioTracks: VideoMediaTrack[];
	readonly subtitleTracks: VideoMediaTrack[];
	readonly selectedAudioTrack: number;
	readonly selectedSubtitleTrack: number;
	readonly trackError: string;
	selectAudioTrack(id: number): void;
	selectSubtitleTrack(id: number): void;
	getSubtitleText(seconds?: number): string;
}
