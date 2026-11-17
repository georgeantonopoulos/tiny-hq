import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allBuilds, keepReason, kindOf, pickToClear, projectsIn, type Candidate } from '../src/team/disk-tidy.ts';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;

test('only real build folders count', () => {
  assert.equal(kindOf('/p/target', ['CACHEDIR.TAG', 'debug']), 'rust');
  assert.equal(kindOf('/p/target', ['notes.md']), undefined); // a folder someone named target
  assert.equal(kindOf('/p/build', ['CMakeCache.txt']), 'cmake');
  assert.equal(kindOf('/p/build', ['index.html']), undefined); // a web build output may be shipped
  assert.equal(kindOf('/p/.next', ['BUILD_ID']), 'next');
  assert.equal(kindOf('/p/node_modules', ['x']), undefined);
});

test('oldest idle folders go first, and only until enough is free', () => {
  const c = (path: string, newest: number, gbs: number, keep?: string): Candidate => ({ path, kind: 'rust', project: '/p', newest, bytes: gbs * GB, keep });
  const pick = pickToClear([c('new', 3, 30), c('old', 1, 30), c('busy', 0, 99, 'busy'), c('mid', 2, 30)], 20 * GB, 75 * GB);
  assert.deepEqual(pick.map((x) => x.path), ['old', 'mid']);
  assert.deepEqual(pickToClear([c('old', 1, 30)], 90 * GB, 80 * GB), []);
});

test('fresh, busy, unignored and tracked build folders stay', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'disk-tidy-')));
  const proj = join(home, 'Dev', 'app');
  const target = join(proj, 'target');
  mkdirSync(join(target, 'debug'), { recursive: true });
  writeFileSync(join(target, 'CACHEDIR.TAG'), 'x');
  const old = new Date(Date.now() - 5 * DAY);
  for (const p of [join(target, 'debug'), join(target, 'CACHEDIR.TAG'), target]) utimesSync(p, old, old);
  const git = (...a: string[]) => execFileSync('git', ['-C', proj, ...a], { stdio: 'ignore' });
  git('init', '-q');

  const c = allBuilds(projectsIn([join(home, 'Dev')]), home)[0]!;
  assert.equal(c.path, target);
  const now = Date.now();
  assert.equal(keepReason(c, [], now), 'not git-ignored');
  writeFileSync(join(proj, '.gitignore'), 'target/\n');
  assert.equal(keepReason(c, [], now), undefined); // idle, ignored, nobody busy: may go
  assert.match(keepReason(c, [join(proj, '.claude/worktrees/x')], now) ?? '', /busy/);
  assert.match(keepReason({ ...c, newest: now - DAY }, [], now) ?? '', /last 2 days/);
  git('add', '-f', 'target/CACHEDIR.TAG');
  assert.ok(keepReason(c, [], now)); // tracked files: git no longer calls it ignored either way
});

test("the owner's projects: each folder in a project folder, plus extras not already inside one", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'disk-tidy-')));
  for (const d of ['code/a', 'code/b', 'code/node_modules', 'elsewhere/c']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, 'code', 'notes.txt'), 'x');
  const got = projectsIn([join(home, 'code'), join(home, 'missing')], [join(home, 'elsewhere/c'), join(home, 'code/a/sub'), join(home, 'gone')]);
  assert.deepEqual(got.sort(), [join(home, 'code/a'), join(home, 'code/b'), join(home, 'elsewhere/c')]);
});

test('disk tidy is off unless the owner switches it on', async () => {
  const { DEFAULT_CONFIG, loadConfig } = await import('../src/config.ts');
  assert.equal(DEFAULT_CONFIG.extras.diskTidy, false);
  const dir = mkdtempSync(join(tmpdir(), 'disk-tidy-cfg-'));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ extras: { diskTidy: 'yes' } }));
  assert.equal(loadConfig(join(dir, 'c.json')).extras.diskTidy, false);
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ extras: { diskTidy: true } }));
  assert.equal(loadConfig(join(dir, 'c.json')).extras.diskTidy, true);
});
