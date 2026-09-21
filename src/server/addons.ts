import type { Addon } from '../stremio/addons';
import { json, text, type HttpHandler } from './http';

export interface AddonSetup {
	origin(): string;
	code: string;
	list(): Addon[];
	install(url: string): Promise<void>;
	remove(url: string): Promise<void>;
	changed(): void;
	external?(): string | undefined;
}

/** Paired phone access for add-on management and selected external service links. */
export function createAddonHandler(setup: AddonSetup): HttpHandler {
	let failures = 0;
	let retryAt = 0;
	let changing = false;
	return async req => {
		const origin = setup.origin();
		if (req.headers.get('host') !== new URL(origin).host) return text(403, 'Open the address shown on the Switch.');
		if (req.method === 'GET' && req.path === '/') return {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" },
			body: new TextEncoder().encode(PAGE),
		};
		if (req.method !== 'POST' || req.path !== '/api/addons') return text(404, 'Not found');
		if (req.headers.get('origin') !== origin || !req.headers.get('content-type')?.startsWith('application/json')) return text(403, 'Open the setup page first.');
		if (req.body.length > 12 * 1024) return text(400, 'Request too large');
		if (Date.now() < retryAt) return json(429, { error: 'Too many incorrect codes. Wait one minute.' });
		let body: { code?: unknown; action?: unknown; url?: unknown };
		try { body = JSON.parse(new TextDecoder().decode(req.body)); } catch { return json(400, { error: 'Invalid request.' }); }
		if (!body || body.code !== setup.code) {
			if (++failures >= 5) { retryAt = Date.now() + 60000; failures = 0; }
			return json(403, { error: 'Enter the pairing code shown on the Switch.' });
		}
		failures = 0;
		if (!['list', 'install', 'remove'].includes(String(body.action))) return json(400, { error: 'Unknown action.' });
		if (changing) return json(409, { error: 'An add-on change is in progress. Try again shortly.' });
		try {
			if (body.action !== 'list') {
				if (typeof body.url !== 'string') return json(400, { error: 'Enter an add-on install link.' });
				changing = true;
				if (body.action === 'install') await setup.install(body.url);
				else await setup.remove(body.url);
				setup.changed();
			}
			return json(200, { external: setup.external?.(), addons: setup.list().map(a => ({ url: a.transportUrl, name: a.manifest.name, version: a.manifest.version, protected: !!a.flags?.protected })) });
		} catch (error) {
			return json(400, { error: error instanceof Error ? error.message : 'Add-on change failed.' });
		} finally { changing = false; }
	};
}

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stremio NX add-ons</title>
<style>body{font:17px system-ui;background:#0f0d1f;color:#fff;max-width:660px;margin:40px auto;padding:0 20px}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #655a91;margin:6px 0}input{box-sizing:border-box;width:100%;background:#211c36;color:#fff}button{background:#7551de;color:white;cursor:pointer}li{margin:18px 0}p{line-height:1.5}#status{white-space:pre-wrap;color:#d7ccff}button:disabled{opacity:.5}</style>
<h1>Stremio NX add-ons</h1><p>Keep Stremio NX open on your Switch. Both devices must use the same Wi-Fi network.</p>
<form id="pair"><label for="code">Pairing code shown on the Switch</label><input id="code" autocomplete="off" maxlength="8" required><button>Connect</button></form>
<section id="manage" hidden><h2>Selected service link</h2><p>Choose an “open on phone” source on the Switch, then refresh here. Playback opens on this device and may require your provider's app or subscription.</p><button id="refresh" type="button">Refresh selected link</button><p><a id="external" hidden target="_blank" rel="noopener noreferrer" style="color:#d7ccff">Open service</a></p><h2>Install an add-on</h2><p>Open the add-on's website on this device and finish its configuration. Copy its <strong>Install</strong> link and paste it below. Both <strong>stremio://</strong> links and HTTP(S) manifest links work. If Install opens another app, press and hold or right-click the button to copy its link.</p>
<form id="install"><label for="url">Configured add-on install link</label><input id="url" type="text" autocapitalize="off" spellcheck="false" placeholder="https://example.com/manifest.json" required><button>Install on Switch</button></form><h2>Installed add-ons</h2><ul id="addons"></ul></section><p id="status" role="status" aria-live="polite"></p>
<script>
const $=id=>document.getElementById(id);let busy=false;
async function request(action,url){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);$('status').textContent='Working…';try{const response=await fetch('/api/addons',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:$('code').value.trim().toUpperCase(),action,url})});const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed.');$('manage').hidden=false;$('external').hidden=true;$('external').removeAttribute('href');if(data.external){const link=new URL(data.external);if(['https:','http:'].includes(link.protocol)&&!link.username&&!link.password){$('external').href=link.href;$('external').textContent='Open '+link.hostname;$('external').hidden=false}}$('addons').replaceChildren();for(const addon of data.addons){const li=document.createElement('li');const name=document.createElement('span');name.textContent=addon.name+' · '+addon.version+' ';li.append(name);if(!addon.protected){const button=document.createElement('button');button.textContent='Remove';button.onclick=()=>{if(confirm('Remove '+addon.name+'?'))request('remove',addon.url)};li.append(button)}$('addons').append(li)}$('status').textContent=action==='list'?'Connected.':action==='install'?'Installed on your Switch.':'Add-on removed.';if(action==='install')$('url').value='';}catch(e){$('status').textContent=e.message}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)}}
$('pair').onsubmit=e=>{e.preventDefault();request('list')};$('install').onsubmit=e=>{e.preventDefault();request('install',$('url').value)};
$('refresh').onclick=()=>request('list');
</script></html>`;
