import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropMouseModeSet } from '../web/app/mouse-hold.ts';

test('a held drag survives Claude Code re-sending its mouse modes', () => {
  // The burst Claude Code sends on focus-in, while the owner is mid-drag: all dropped.
  assert.equal(dropMouseModeSet([1000], 'any', true), true);
  assert.equal(dropMouseModeSet([1002], 'any', true), true);
  assert.equal(dropMouseModeSet([1003], 'any', true), true);
  // Nothing held: every request goes through as before.
  assert.equal(dropMouseModeSet([1000], 'any', false), false);
  // Raising the mode, or turning tracking on, always goes through.
  assert.equal(dropMouseModeSet([1003], 'drag', true), false);
  assert.equal(dropMouseModeSet([1000], 'none', true), false);
  // Mixed with anything that isn't a tracking mode (bracketed paste, SGR encoding): untouched.
  assert.equal(dropMouseModeSet([1000, 1006], 'any', true), false);
  assert.equal(dropMouseModeSet([2004], 'any', true), false);
  assert.equal(dropMouseModeSet([], 'any', true), false);
});
