import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The office's regular tick runs every step through one loop that catches each step's failure, so one
// bad step (a broken job file, a GitHub error) never skips the runaway checks after it.
// A step called straight from the tick body would lose that.
const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');

test('the tick only runs TICK_STEPS, each step caught on its own', () => {
  const start = main.indexOf('const tick = async () => {');
  const tick = main.slice(start, main.indexOf('setTimeout(() => void tick()', start));
  assert.ok(start > 0 && tick.length > 0, 'the tick is where this test expects it');
  const calls = new Set([...tick.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
  for (const keyword of ['async', 'if', 'for', 'catch']) calls.delete(keyword);
  assert.deepEqual([...calls].sort(), ['error', 'step'], `the tick calls something outside TICK_STEPS: ${[...calls].join(', ')}`);
  assert.match(tick, /for \(const \[name, step\] of TICK_STEPS\) \{\s*try \{\s*await step\(\);\s*\} catch/);
});

test('the checks that must always run are tick steps', () => {
  const steps = main.slice(main.indexOf('const TICK_STEPS'), main.indexOf('const tick = async'));
  for (const name of ['runSchedule', 'runJobs', 'runEvening', 'runaways', 'carryOnAfterApiErrors', 'coffeeRoom']) {
    assert.match(steps, new RegExp(`\\b${name}\\b`), `${name} is a tick step`);
  }
});
