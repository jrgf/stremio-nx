/**
 * Host shims that let stremio-core-web's wasm-bindgen glue run outside a
 * browser Web Worker (nx.js on Switch, or Node for the host test).
 *
 * Must be imported before `@stremio/stremio-core-web/stremio_core_web.js`:
 * that module reads `document.baseURI` at evaluation time.
 *
 * Required surface, taken from the 0.62.1 glue + stremio-core-web/src/env.rs:
 *   - `self`                 glue reads app/shell version + storage hooks off it
 *   - `document.baseURI`     top-level `import.meta` polyfill in the glue
 *   - `WorkerGlobalScope`    env.rs does `js_sys::global().dyn_into::<WorkerGlobalScope>()`,
 *                            which compiles to `global instanceof WorkerGlobalScope`
 *   - `Request` headers      env.rs passes `{ name: string[] }`; browsers coerce the
 *                            array via toString(), other runtimes may not
 *   - storage hooks          `local_storage_{get,set,remove}_item`, async, string values
 *   - `get_location_hash`    used for analytics paths only
 */

export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface ShimOptions {
	appVersion: string;
	shellVersion: string;
	storage: KeyValueStore;
}

type AnyGlobal = typeof globalThis & Record<string, unknown>;

export function installShims(opts: ShimOptions): void {
	const g = globalThis as AnyGlobal;

	g.self ??= g;

	g.document ??= { baseURI: 'file:///' };

	if (typeof g.WorkerGlobalScope === 'undefined') {
		class WorkerGlobalScope {
			static [Symbol.hasInstance](value: unknown): boolean {
				return value === globalThis;
			}
		}
		g.WorkerGlobalScope = WorkerGlobalScope;
	}

	const NativeRequest = g.Request as typeof Request;
	class CoreRequest extends NativeRequest {
		constructor(input: ConstructorParameters<typeof Request>[0], init?: RequestInit) {
			super(input, init && { ...init, headers: normalizeHeaders(init.headers) });
		}
	}
	g.Request = CoreRequest;

	g.app_version = opts.appVersion;
	g.shell_version = opts.shellVersion;
	g.get_location_hash = async () => '';
	g.local_storage_get_item = async (key: string) => opts.storage.getItem(key);
	g.local_storage_set_item = async (key: string, value: string) => opts.storage.setItem(key, value);
	g.local_storage_remove_item = async (key: string) => opts.storage.removeItem(key);
}

function normalizeHeaders(headers: unknown): HeadersInit | undefined {
	if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
		return headers as HeadersInit | undefined;
	}
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name] = Array.isArray(value) ? value.join(', ') : String(value);
	}
	return out;
}

export class MemoryStore implements KeyValueStore {
	#map = new Map<string, string>();
	getItem(key: string) {
		return this.#map.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.#map.set(key, value);
	}
	removeItem(key: string) {
		this.#map.delete(key);
	}
}
