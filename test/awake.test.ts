import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awakeNow, awakePath, isCaffeinate, keepAwakeIfOn, readAwake, setAwake } from '../src/team/awake.ts';

test('the switch starts one caffeinate, keeps it, and stops it', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'awake-'));
  assert.deepEqual(awakeNow(dir), { on: false }, 'off when never set');
  const a = setAwake(dir, true, 1000);
  try {
    assert.ok(isCaffeinate(a.pid), 'a real caffeinate is running');
    assert.equal(awakeNow(dir).on, true);
    assert.equal(setAwake(dir, true, 2000).pid, a.pid, 'on twice: still the one caffeinate');
    assert.equal(readAwake(awakePath(dir)).since, 1000);
  } finally {
    setAwake(dir, false);
  }
  assert.deepEqual(awakeNow(dir), { on: false });
  assert.equal(readAwake(awakePath(dir)).on, false);
});

test('switch on but its caffeinate gone (office restarted): Tiny HQ starts a new one', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'awake-'));
  writeFileSync(awakePath(dir), JSON.stringify({ on: true, pid: 999999, since: 5 }));
  assert.equal(awakeNow(dir).on, false, 'the page never claims awake without a caffeinate');
  keepAwakeIfOn(dir);
  try {
    assert.equal(awakeNow(dir).on, true);
  } finally {
    setAwake(dir, false);
  }
});

test('never stops a process that is not a caffeinate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awake-'));
  writeFileSync(awakePath(dir), JSON.stringify({ on: true, pid: process.pid }));
  setAwake(dir, false); // would kill this test run if it signalled the wrong pid
  assert.equal(readAwake(awakePath(dir)).on, false);
});

test('wiring: the tick re-checks it, the page has the button', () => {
  assert.match(readFileSync('src/daemon/main.ts', 'utf8'), /\['stay awake', \(\) => keepAwakeIfOn\(DATA_DIR\)\]/);
  assert.match(readFileSync('web/index.html', 'utf8'), /id="awake"/);
  assert.match(readFileSync('web/app/main.ts', 'utf8'), /wireAwakeSwitch\(\$\('awake'\)/);
});
