import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { sha1 } from '../src/platform/sha1';

const reference = (data: Uint8Array) => new Uint8Array(createHash('sha1').update(data).digest());

test('sha1 matches node for padding edge cases and large input', () => {
	for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 256 * 1024, 1024 * 1024 + 3]) {
		const data = new Uint8Array(randomBytes(length));
		assert.deepEqual(sha1(data), reference(data), `length ${length}`);
	}
	assert.equal(Buffer.from(sha1(new TextEncoder().encode('abc'))).toString('hex'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
