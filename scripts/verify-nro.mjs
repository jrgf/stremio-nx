import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NACP } from '@tootallnate/nacp';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(root + path);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pkg = JSON.parse(read('package.json'));
const nro = read(pkg.name + '.nro');
const runtime = read('runtime/nxjs.nro');
const nativeSize = nro.readUInt32LE(0x18);
assert.equal(nativeSize, runtime.readUInt32LE(0x18));
assert.ok(nro.subarray(0, nativeSize).equals(runtime.subarray(0, nativeSize)), 'Rebuilt native runtime');
assert.equal(nro.toString('ascii', nativeSize, nativeSize + 4), 'ASET');
function asset(offset) {
  const start = nativeSize + Number(nro.readBigUInt64LE(nativeSize + offset));
  const size = Number(nro.readBigUInt64LE(nativeSize + offset + 8));
  assert.ok(start >= nativeSize && start + size <= nro.length, 'Asset bounds');
  return nro.subarray(start, start + size);
}
assert.ok(asset(8).equals(read('icon.jpg')), 'Custom icon');
const metadata = asset(24);
const nacp = new NACP(metadata.buffer.slice(metadata.byteOffset, metadata.byteOffset + metadata.byteLength));
assert.equal(nacp.title, pkg.name);
assert.equal(nacp.author, pkg.author);
assert.equal(nacp.version, pkg.version);
const romfs = asset(40);
const table = Number(romfs.readBigUInt64LE(56));
const end = table + Number(romfs.readBigUInt64LE(64));
const data = Number(romfs.readBigUInt64LE(72));
const entries = new Map();
for (let pos = table; pos < end;) {
  const length = romfs.readUInt32LE(pos + 28);
  const name = romfs.toString('utf8', pos + 32, pos + 32 + length);
  const start = data + Number(romfs.readBigUInt64LE(pos + 8));
  const size = Number(romfs.readBigUInt64LE(pos + 16));
  entries.set(name, romfs.subarray(start, start + size));
  pos += 32 + Math.ceil(length / 4) * 4;
}
for (const name of ['main.js', 'nxjs.ini', 'LICENSE', 'COPYRIGHT', 'THIRD_PARTY_NOTICES.txt']) {
  assert.ok(entries.get(name)?.equals(read('romfs/' + name)), name);
}
assert.ok(entries.get('main.js').includes('stremio-nx build '));
for (const marker of ['[video] requesting NVDEC via NVTEGRA', '[video] NVDEC active:']) assert.ok(runtime.includes(marker), marker);
const info = {
  name: pkg.name, version: pkg.version, author: nacp.author, license: pkg.license,
  revision: process.env.GITHUB_SHA ?? null,
  builtAt: new Date().toISOString(), bytes: nro.length, sha256: hash(nro),
  runtimeSha256: hash(runtime), appSha256: hash(entries.get('main.js')),
  verified: ['rebuilt runtime', 'icon', 'title/author/version', 'app/config', 'license/notices', 'NVDEC markers']
};
mkdirSync(root + 'artifacts', { recursive: true });
writeFileSync(root + 'artifacts/build-info.json', JSON.stringify(info, null, 2) + '\n');
writeFileSync(root + 'artifacts/SHA256SUMS', info.sha256 + '  ' + pkg.name + '.nro\n');
console.log(JSON.stringify(info, null, 2));
