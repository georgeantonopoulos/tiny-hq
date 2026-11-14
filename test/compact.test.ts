import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGAIN_MS, contextFrom, QUIET_MS, shouldCompact } from '../src/team/compact.ts';

const step = (read: number, side = false) => JSON.stringify({ type: 'assistant', isSidechain: side, message: { usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 500 } } });
const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });

test('the last main step tells the conversation size; helpers and broken lines are skipped', () => {
  assert.equal(contextFrom([step(100_000), step(450_000), step(5_000, true), '{oops']), 450_510);
});

test('a summary after the last step means the conversation is short again', () => {
  assert.equal(contextFrom([step(450_000), boundary]), 0);
  assert.equal(contextFrom([step(450_000), boundary, step(30_000)]), 30_510);
});

test('only a long, quiet session not asked within the hour is summarised', () => {
  const now = 10 * AGAIN_MS;
  assert.equal(shouldCompact({ tokens: 456_000, quietFor: QUIET_MS, now }), true);
  assert.equal(shouldCompact({ tokens: 180_000, quietFor: QUIET_MS, now }), false);
  assert.equal(shouldCompact({ tokens: 456_000, quietFor: QUIET_MS - 1, now }), false);
  assert.equal(shouldCompact({ tokens: 456_000, quietFor: QUIET_MS, askedAt: now - AGAIN_MS + 1, now }), false);
  assert.equal(shouldCompact({ tokens: 456_000, quietFor: QUIET_MS, askedAt: now - AGAIN_MS, now }), true);
});
