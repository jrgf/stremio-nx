/**
 * Host tests for the torrent parsing layer: bencode round-trip, magnet parsing
 * (hex + base32), and .torrent info-hash + layout. Run via `npm run host-test:unit`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { asDict, asInt, asString, type Bencode, decode, encode } from '../src/torrent/bencode';
import { parseInfoDict, parseMagnet, parseTorrentFile, validateInfo } from '../src/torrent/metainfo';
import { InfoHash } from '../src/torrent/types';
import { nodePlatform } from './node-platform';

const bytes = (s: string) => new TextEncoder().encode(s);

test('bencode round-trips ints, byte strings, lists, dicts', () => {
	const value: Bencode = new Map<string, Bencode>([
		['n', 42],
		['neg', -7],
		['s', bytes('hello')],
		['list', [1, bytes('a'), [2]]],
	]);
	const encoded = encode(value);
	const decoded = asDict(decode(encoded));
	assert.equal(asInt(decoded.get('n')), 42);
	assert.equal(asInt(decoded.get('neg')), -7);
	assert.equal(asString(decoded.get('s')), 'hello');
	// Keys are emitted in sorted byte order: list < n < neg < s.
	assert.equal(new TextDecoder().decode(encoded).slice(0, 7), 'd4:list');
});

test('bencode rejects malformed input', () => {
	assert.throws(() => decode(bytes('i12')), /unterminated integer/);
	assert.throws(() => decode(bytes('3:ab')), /past end/);
	assert.throws(() => decode(bytes('x')), /unexpected byte/);
});

test('parseMagnet reads hex and base32 info hashes, trackers, name', () => {
	const hex = '0123456789abcdef0123456789abcdef01234567';
	const m = parseMagnet(`magnet:?xt=urn:btih:${hex}&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftr1&tr=http%3A%2F%2Ftr2`);
	assert.equal(m.infoHash.toHex(), hex);
	assert.equal(m.displayName, 'Big Buck Bunny');
	assert.deepEqual(m.announce, ['udp://tr1', 'http://tr2']);
	assert.equal(m.fileIdx, null);

	// Base32 (32 chars) decodes to the same 20 bytes as its hex form.
	const b32 = 'AERSJZTZVE677AJDIVTYTIWP54ARGRDH';
	const fromB32 = parseMagnet(`magnet:?xt=urn:btih:${b32}`);
	assert.equal(fromB32.infoHash.toHex(), InfoHash.fromHex(fromB32.infoHash.toHex()).toHex());
	assert.equal(fromB32.infoHash.bytes.length, 20);
});

test('InfoHash hex round-trip and equality', () => {
	const hex = 'aabbccddeeff00112233445566778899aabbccdd';
	assert.equal(InfoHash.fromHex(hex).toHex(), hex);
	assert.ok(InfoHash.fromHex(hex).equals(InfoHash.fromHex(hex)));
	assert.throws(() => InfoHash.fromHex('abc'), /40 chars/);
});

test('parseTorrentFile computes the info hash over raw bytes and reads the layout', async () => {
	// A 3-piece multi-file torrent.
	const pieceLength = 32768;
	const pieceHashes = new Uint8Array(60); // 3 * 20, contents irrelevant here
	for (let i = 0; i < pieceHashes.length; i++) pieceHashes[i] = i;
	const info = new Map<string, Bencode>([
		['name', bytes('show')],
		['piece length', pieceLength],
		['pieces', pieceHashes],
		[
			'files',
			[
				new Map<string, Bencode>([['length', 40000], ['path', [bytes('a.mkv')]]]),
				new Map<string, Bencode>([['length', 50000], ['path', [bytes('b'), bytes('c.srt')]]]),
			],
		],
	]);
	const torrent = encode(new Map<string, Bencode>([['announce', bytes('udp://x')], ['info', info]]));
	const expectedHash = new Uint8Array(createHash('sha1').update(encode(info)).digest());

	const parsed = await parseTorrentFile(torrent, nodePlatform);
	assert.deepEqual(parsed.infoHash.bytes, expectedHash);
	assert.equal(parsed.name, 'show');
	assert.equal(parsed.pieceLength, pieceLength);
	assert.equal(parsed.pieceHashes.length, 3);
	assert.equal(parsed.totalLength, 90000);
	assert.deepEqual(parsed.files[0].path, ['show', 'a.mkv']);
	assert.deepEqual(parsed.files[1].path, ['show', 'b', 'c.srt']);
	assert.equal(parsed.files[1].offset, 40000);
	validateInfo(parsed);
});

test('single-file torrent layout', async () => {
	const info = new Map<string, Bencode>([
		['name', bytes('movie.mkv')],
		['piece length', 16384],
		['pieces', new Uint8Array(20)],
		['length', 10000],
	]);
	const parsed = parseInfoDict(info, InfoHash.fromHex('00'.repeat(20)));
	assert.equal(parsed.files.length, 1);
	assert.deepEqual(parsed.files[0].path, ['movie.mkv']);
	assert.equal(parsed.totalLength, 10000);
});
