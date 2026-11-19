import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from '../src/team/file-lock.ts';
import { addAsk, loadAsks, updateAsks } from '../src/team/asks.ts';
import { loadJobs, updateJobs, type Job } from '../src/team/jobs.ts';

// asks.json and jobs.json are changed by the office and by the manager/ask and manager/job commands, each
// reading the file, changing it and writing it back. Two at once lost one change.
// Every write now goes through updateAsks / updateJobs, under one lock.

test('nothing writes asks.json or jobs.json except under the lock', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(f)) files.push(p);
    }
  };
  walk(new URL('../src', import.meta.url).pathname);
  walk(new URL('../hooks', import.meta.url).pathname);
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /\bsave(Asks|Jobs)\s*\(/, `${f} writes asks or jobs without the lock: use updateAsks / updateJobs`);
    if (!/src\/team\/(asks|jobs)\.ts$/.test(f)) assert.doesNotMatch(s, /\bwrite(Asks|Jobs)\s*\(/, `${f} writes asks or jobs without the lock`);
  }
  for (const f of ['asks', 'jobs']) {
    const s = readFileSync(new URL(`../src/team/${f}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /export function write(Asks|Jobs)/, 'the raw write stays private');
    // The only raw write is the one inside the locked update.
    assert.equal(s.match(/\bwrite(Asks|Jobs)\s*\(/g)?.length, 2, `${f}.ts: one definition, one call inside update`);
  }
});

test('the lock waits for a live holder, takes over a stale one, and lets go after a throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const path = join(dir, 'x.json');
  // Held by someone else just now: waits, then gives up with the busy message.
  mkdirSync(`${path}.lock`);
  writeFileSync(`${path}.lock/at`, String(Date.now()));
  const t = Date.now();
  assert.throws(() => withFileLock(path, () => 1, 'x is busy'), /x is busy/);
  assert.ok(Date.now() - t >= 2500, 'it waited before giving up');
  // Left behind by a crash over 10 s ago: taken over.
  writeFileSync(`${path}.lock/at`, String(Date.now() - 20_000));
  assert.equal(withFileLock(path, () => 7), 7);
  assert.equal(existsSync(`${path}.lock`), false, 'released');
  assert.throws(() => withFileLock(path, () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(`${path}.lock`), false, 'released after a throw');
});

test('two processes adding questions at once keep both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const path = join(dir, 'asks.json');
  const asksTs = new URL('../src/team/asks.ts', import.meta.url).href;
  // Each child adds 10 questions over its own room, one locked update at a time.
  const child = (room: string) =>
    new Promise<void>((done, fail) => {
      const code = `import { addAsk, updateAsks } from '${asksTs}';\nfor (let i = 0; i < 10; i++) updateAsks(${JSON.stringify(path)}, (all) => addAsk(all, ${JSON.stringify(room)} + i, 'q' + i, Date.now(), ${JSON.stringify(room.slice(-1))} + 'id' + i + 'xx'));`;
      const p = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? done() : fail(new Error(`child exited ${c}`))));
    });
  await Promise.all([child('/r/a'), child('/r/b')]);
  assert.equal(loadAsks(path).length, 20, 'no question lost');
});

test('updateJobs and updateAsks change only what the caller changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const jobs = join(dir, 'jobs.json');
  const job = (id: string): Job => ({ id, title: id, done: 'x', room: '/r', status: 'active', createdAt: 1, updatedAt: 1 }) as Job;
  updateJobs(jobs, () => [job('a1'), job('b1')]);
  updateJobs(jobs, (all) => all.map((j) => (j.id === 'a1' ? { ...j, status: 'done' as const } : j)));
  assert.deepEqual(loadJobs(jobs).map((j) => `${j.id}:${j.status}`).sort(), ['a1:done', 'b1:active']);
  const asks = join(dir, 'asks.json');
  const after = updateAsks(asks, (all) => addAsk(all, '/r', 'q?', 1, 'abc123'));
  assert.equal(after.length, 1);
  assert.equal(loadAsks(asks)[0]?.id, 'abc123');
  assert.equal(execFileSync('ls', [dir]).toString().includes('.lock'), false);
});

test('a lock just taken, its time not written yet, is never taken for a stale one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  const path = join(dir, 'x.json');
  mkdirSync(`${path}.lock`);
  writeFileSync(`${path}.lock/at`, ''); // the holder has created the file but not written the time
  assert.throws(() => withFileLock(path, () => 1, 'x is busy'), /x is busy/);
  assert.equal(existsSync(`${path}.lock`), true, 'the live lock is left alone');
});
