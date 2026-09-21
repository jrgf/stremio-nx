/** Add-on manifests are data, fetched over HTTP; no browser or add-on code runs on the Switch. */
export interface AddonManifest {
	id: string;
	name: string;
	version: string;
	description?: string;
	types: string[];
	resources: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
	idPrefixes?: string[];
	catalogs: { type: string; id: string; name?: string }[];
	behaviorHints?: { configurable?: boolean; configurationRequired?: boolean };
}

export interface Addon {
	transportUrl: string;
	manifest: AddonManifest;
	flags?: { official?: boolean; protected?: boolean };
}

export function manifestUrl(input: string): string {
	if (input.length > 8192) throw new Error('Add-on link is too long.');
	let url: URL;
	try { url = new URL(input.trim().replace(/^stremio:\/\//i, 'https://')); }
	catch { throw new Error('Enter an https:// or stremio:// add-on install link.'); }
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
		throw new Error('Use an HTTP(S) add-on link without a username or password.');
	}
	url.hash = '';
	if (!url.pathname.endsWith('/manifest.json')) {
		if (url.pathname.endsWith('/configure')) throw new Error('Finish configuration in your browser, then copy the install link.');
		url.pathname = url.pathname.replace(/\/$/, '') + '/manifest.json';
	}
	return url.href;
}

/** Bound both elapsed time and decoded response bytes, including chunked responses. */
export async function fetchTextLimited(url: string, limit: number, signal?: AbortSignal): Promise<string> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener('abort', abort);
	const timer = setTimeout(abort, 15000);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
		if (Number(response.headers.get('content-length')) > limit) throw new Error('Response is too large.');
		if (!response.body) throw new Error('Server returned an empty response.');
		reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) throw new Error('Response is too large.');
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		return new TextDecoder().decode(bytes);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
		await reader?.cancel().catch(() => {});
		controller.abort();
	}
}

export async function fetchAddon(input: string): Promise<Addon> {
	const transportUrl = manifestUrl(input);
	let manifest: AddonManifest;
	try { manifest = JSON.parse(await fetchTextLimited(transportUrl, 256 * 1024)); }
	catch (error) {
		if (error instanceof SyntaxError) throw new Error('This link did not return an add-on manifest. Copy the install link after configuration.');
		throw error;
	}
	const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(x => typeof x === 'string' && x.length <= 256);
	if (!manifest || typeof manifest !== 'object' || !manifest.id || typeof manifest.id !== 'string' || manifest.id.length > 256 ||
		typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 256 ||
		typeof manifest.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[\da-zA-Z-]*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[\da-zA-Z-]*[a-zA-Z-][\da-zA-Z-]*))*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(manifest.version) ||
		!strings(manifest.types) || (manifest.idPrefixes !== undefined && !strings(manifest.idPrefixes)) ||
		!Array.isArray(manifest.resources) || manifest.resources.length > 100 || !manifest.resources.every(r =>
			typeof r === 'string' || (r && typeof r.name === 'string' && (r.types === undefined || strings(r.types)) && (r.idPrefixes === undefined || strings(r.idPrefixes))))) {
		throw new Error('Invalid add-on manifest: expected a name, id, version, types and resources.');
	}
	manifest.catalogs ??= [];
	if (!Array.isArray(manifest.catalogs) || manifest.catalogs.length > 500 || !manifest.catalogs.every(c => c && typeof c.id === 'string' && typeof c.type === 'string')) {
		throw new Error('Invalid add-on catalog list.');
	}
	if (manifest.behaviorHints?.configurationRequired) throw new Error('This add-on needs configuration. Finish setup on its website, then copy the configured install link.');
	return { transportUrl, manifest, flags: { official: false, protected: false } };
}
