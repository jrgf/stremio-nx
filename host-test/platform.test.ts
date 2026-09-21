/**
 * Host test for the platform adapter contract the engine relies on: a
 * connect that does not complete within the timeout rejects promptly and
 * leaves no attempt behind.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodePlatform } from './node-platform';

test('connect rejects after the timeout instead of hanging', async () => {
	const start = Date.now();
	// 10.255.255.1 is a non-routable address: the SYN is black-holed.
	await assert.rejects(nodePlatform.connect('10.255.255.1', 6881, 300), /timed out/);
	const elapsed = Date.now() - start;
	assert.ok(elapsed >= 250 && elapsed < 2000, `rejected after ${elapsed} ms`);
});
