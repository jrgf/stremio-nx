/**
 * Thin main-thread wrapper around stremio-core-web.
 *
 * stremio-web runs the core inside a Web Worker via worker.js/bridge.js; neither
 * runtime we target has Workers, so this calls the wasm-bindgen exports directly.
 * Call `installShims()` before importing this module.
 */
import * as glue from '@stremio/stremio-core-web/stremio_core_web.js';
import wasmBytes from '@stremio/stremio-core-web/stremio_core_web_bg.wasm';

export type CoreEvent = { name: string; args: unknown };
export type CoreEventListener = (event: CoreEvent) => void;

export interface StremioCore {
	dispatch(action: unknown, field?: string | null): void;
	getState<T = unknown>(field: string): T;
}

// The glue is Babel-emitted CJS (`exports.default` + `__esModule`). Depending on
// esbuild's interop mode, `default` is either the init function or the whole
// exports object, so resolve it explicitly.
type Glue = typeof glue;
const exportsObj: Glue = typeof glue.default === 'function' ? glue : (glue.default as unknown as Glue);

export async function createCore(onEvent: CoreEventListener): Promise<StremioCore> {
	await exportsObj.default({ module_or_path: wasmBytes });
	await exportsObj.initialize_runtime((event: CoreEvent) => onEvent(event));
	return {
		dispatch: (action, field = null) => exportsObj.dispatch(action, field, ''),
		getState: <T>(field: string) => exportsObj.get_state(field) as T,
	};
}
