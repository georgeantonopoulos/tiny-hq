import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run by a relative path (`manager/delegate`), delegate must still find its trust check after it
// moves into the project, or Claude Code refuses to start in an untrusted folder with no button.
test('delegate, run by a relative path, puts up Trust and start for an untrusted folder', () => {
  const office = new URL('..', import.meta.url).pathname;
  const data = mkdtempSync(join(tmpdir(), 'cm-deleg-'));
  const project = mkdtempSync(join(tmpdir(), 'cm-untrusted-')); // never trusted in ~/.claude.json
  const r = spawnSync('sh', ['manager/delegate', project, 'Test Room', 'do a thing'], {
    cwd: office,
    env: { ...process.env, CM_DATA_DIR: data, CM_CLAUDE_BIN: '/bin/echo', CLAUDE_CODE_SESSION_ID: '' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 3, `expected the trust button, got: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /Trust and start/);
  assert.doesNotMatch(r.stdout, /do a thing/, 'Claude was never started');
  const asks = JSON.parse(readFileSync(join(data, 'manager', 'asks.json'), 'utf8')) as { asks: { trust?: { name: string } }[] };
  assert.equal(asks.asks[0]?.trust?.name, 'Test Room');
});

// A task that starts with "-" must reach Claude as the task, never as one of its options.
test('delegate ends Claude options with "--" before the task', async () => {
  const { mkdirSync, realpathSync, writeFileSync } = await import('node:fs');
  const office = new URL('..', import.meta.url).pathname;
  const home = mkdtempSync(join(tmpdir(), 'cm-deleg-home-'));
  const data = join(home, 'data');
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cm-trusted-')));
  mkdirSync(data, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
  const r = spawnSync('sh', ['manager/delegate', project, 'Test Room', '--dangerously-skip-permissions'], {
    cwd: office,
    env: { ...process.env, HOME: home, CM_DATA_DIR: data, CM_CLAUDE_BIN: '/bin/echo', CLAUDE_CODE_SESSION_ID: '' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-n Test Room -- --dangerously-skip-permissions\n/);
});
