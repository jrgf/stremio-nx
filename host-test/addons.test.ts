import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAddon, fetchTextLimited, manifestUrl, type Addon } from '../src/stremio/addons';
import { StremioClient } from '../src/stremio/client';
import { installShims } from '../src/shims';
import { createAddonHandler } from '../src/server/addons';

test('configured links, bounded manifests, core persistence and paired add-on management', async () => {
	assert.equal(manifestUrl(' stremio://addon.example/key/manifest.json '), 'https://addon.example/key/manifest.json');
	assert.equal(manifestUrl('https://addon.example/config-token?key=secret'), 'https://addon.example/config-token/manifest.json?key=secret');
	for (const bad of ['file:///sdmc/secrets', 'javascript:alert(1)', 'https://user:pass@example.com/', 'https://example.com/configure']) assert.throws(() => manifestUrl(bad));
	const addon: Addon = { transportUrl: 'https://addon.example/key/manifest.json', manifest: { id: 'org.example.nx', name: 'Example', version: '1.0.0', types: ['movie'], resources: ['subtitles'], catalogs: [] } };
	const originalFetch = globalThis.fetch;
	let manifest: unknown = addon.manifest;
	globalThis.fetch = async () => new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } });
	try {
		assert.equal((await fetchAddon(addon.transportUrl)).manifest.id, addon.manifest.id);
		manifest = { ...addon.manifest, behaviorHints: { configurationRequired: true } };
		await assert.rejects(fetchAddon(addon.transportUrl), /needs configuration/);
		manifest = { name: 'bad' };
		await assert.rejects(fetchAddon(addon.transportUrl), /Invalid add-on manifest/);
		globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)); c.enqueue(new Uint8Array(9)); c.close(); } }));
		await assert.rejects(fetchTextLimited(addon.transportUrl, 10), /too large/);
		manifest = addon.manifest;
		globalThis.fetch = async () => new Response(JSON.stringify(manifest));
		const storage = new Map<string, string>();
		installShims({ appVersion: '0.1.0', shellVersion: 'stremio-nx-test', storage: {
			getItem: k => storage.get(k) ?? null,
			setItem: (k, v) => { storage.set(k, v); },
			removeItem: k => { storage.delete(k); },
		} });
		const core = await StremioClient.create();
		await core.installAddon(addon.transportUrl);
		assert.ok(core.addons().some(a => a.transportUrl === addon.transportUrl));
		const videoStream = { url: 'https://video.example/movie.mkv?token=private', behaviorHints: { filename: 'movie.mkv', proxyHeaders: { request: { Authorization: 'Bearer test' } } } };
		const selected = await core.loadPlayer({ addonName: 'Sample', addonUrl: addon.transportUrl, stream: videoStream }, { id: 'tt1', type: 'movie', name: 'Sample' });
		assert.equal(selected.url, videoStream.url);
		assert.deepEqual(selected.behaviorHints?.proxyHeaders?.request, videoStream.behaviorHints.proxyHeaders.request);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.ok([...storage.values()].some(v => v.includes('org.example.nx')), 'installed descriptor is persisted by the real core');
		await core.installAddon(addon.transportUrl);
		assert.equal(core.addons().filter(a => a.transportUrl === addon.transportUrl).length, 1);
		await core.removeAddon(addon.transportUrl);
		assert.ok(!core.addons().some(a => a.transportUrl === addon.transportUrl));
		const protectedAddon = core.addons().find(a => a.flags?.protected);
		if (protectedAddon) await assert.rejects(core.removeAddon(protectedAddon.transportUrl), /cannot be removed/);

		let installed: Addon[] = [], changed = 0;
		const origin = 'http://192.168.1.2:11471';
		const handler = createAddonHandler({ origin: () => origin, code: '1234ABCD', list: () => installed,
			install: async url => { assert.equal(url, addon.transportUrl); installed = [addon]; },
			remove: async url => { installed = installed.filter(a => a.transportUrl !== url); }, changed: () => { changed++; }, external: () => 'https://provider.example/watch' });
		const request = (body: unknown, originHeader = origin, host = '192.168.1.2:11471') => handler({ method: 'POST', path: '/api/addons', query: new URLSearchParams(), headers: new Map([['host', host], ['origin', originHeader], ['content-type', 'application/json']]), body: new TextEncoder().encode(JSON.stringify(body)) });
		assert.equal((await request({ code: 'bad', action: 'install', url: addon.transportUrl })).status, 403);
		assert.equal((await request({ code: '1234ABCD', action: 'install', url: addon.transportUrl }, 'https://unrelated.example')).status, 403);
		assert.equal((await request({ code: '1234ABCD', action: 'list' }, origin, 'unrelated.example')).status, 403);
		assert.equal(installed.length, 0);
		const paired = await request({ code: '1234ABCD', action: 'list' });
		assert.equal(JSON.parse(new TextDecoder().decode(paired.body as Uint8Array)).external, 'https://provider.example/watch');
		assert.equal((await request({ code: '1234ABCD', action: 'install', url: addon.transportUrl })).status, 200);
		assert.equal(installed.length, 1);
		assert.equal((await request({ code: '1234ABCD', action: 'remove', url: addon.transportUrl })).status, 200);
		assert.equal(installed.length, 0);
		assert.equal(changed, 2);
	} finally { globalThis.fetch = originalFetch; }
});
