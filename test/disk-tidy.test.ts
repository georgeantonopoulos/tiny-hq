import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allBuilds, gitAllows, keepReason, kindOf, pickToClear, projectsIn, idleFor, shortText, type Candidate } from '../src/team/disk-tidy.ts';

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

test('a repo git cannot read keeps its build folders (git errors never let one go)', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'disk-tidy-')));
  const proj = join(home, 'Dev', 'broken');
  mkdirSync(join(proj, 'build'), { recursive: true });
  writeFileSync(join(proj, '.git'), 'gitdir: /nowhere/at/all\n'); // a worktree whose repo is gone
  assert.ok(gitAllows(join(proj, 'build')));
  const plain = join(home, 'Dev', 'plain', 'build');
  mkdirSync(plain, { recursive: true });
  assert.equal(gitAllows(plain), undefined); // no repo anywhere above: fine
});

test('a folder that became busy or fresh after the survey is not removed', async () => {
  const { clear } = await import('../src/team/disk-tidy.ts');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'disk-tidy-')));
  const next = join(home, 'Dev', 'site', '.next');
  mkdirSync(next, { recursive: true });
  writeFileSync(join(next, 'BUILD_ID'), 'x'); // written now: a build just ran
  const surveyed: Candidate = { path: next, kind: 'next', project: join(home, 'Dev', 'site'), newest: Date.now() - 5 * DAY, bytes: GB };
  assert.deepEqual(await clear([surveyed], async () => []), []);
  assert.ok(existsSync(next));
});

test('a nearly full disk lets builds idle for 6 hours go, and the alert names what it kept', () => {
  assert.equal(idleFor(50 * GB), 2 * DAY);
  assert.equal(idleFor(5 * GB), 6 * 60 * 60_000);
  const now = Date.now();
  const c: Candidate = { path: '/x/target', kind: 'rust', project: '/nowhere-' + now, newest: now - 8 * 60 * 60_000 };
  assert.match(keepReason(c, [], now) ?? '', /last 2 days/);
  assert.equal(keepReason(c, [], now, idleFor(5 * GB)), undefined);
  assert.match(keepReason({ ...c, newest: now - 60_000 }, [], now, idleFor(5 * GB)) ?? '', /last 6 hours/);
  assert.match(keepReason(c, [c.project], now, idleFor(5 * GB)) ?? '', /busy/); // a busy session still holds it
  const text = shortText(4 * GB, [{ ...c, bytes: 81 * GB, keep: 'used in the last 6 hours' }]);
  assert.match(text, /4\.0 GB free/);
  assert.match(text, /81\.0 GB \/x\/target/);
});

test('the low-disk alert names what grew since the most was free this week', async () => {
  const { baseline, growthText, snapshotText } = await import('../src/team/disk-growth.ts');
  const now = 10 * DAY;
  const a = { at: now - 2 * DAY, free: 78 * GB, sizes: { '/h/Library/Caches/SomeApp': 20 * GB, '/h/Dev/x': 5 * GB } };
  const b = { at: now - DAY, free: 60 * GB, sizes: { '/h/Library/Caches/SomeApp': 30 * GB } };
  const old = { at: now - 9 * DAY, free: 200 * GB, sizes: {} };
  const empty = { at: now - DAY, free: 300 * GB, sizes: {} };
  assert.equal(baseline([old, a, b, empty], now), a, 'compares with the most free this week, never an empty measurement');
  const t = growthText(a, { at: now, free: 30 * GB, sizes: { '/h/Library/Caches/SomeApp': 38 * GB, '/h/Dev/x': 5.5 * GB, '/h/Library/Containers/docker': 2 * GB } }, '/h');
  assert.match(t, /fell 48\.0 GB/);
  assert.match(t, /\+18\.0 GB ~\/Library\/Caches\/SomeApp; \+2\.0 GB ~\/Library\/Containers\/docker\./, 'biggest first, under 1 GB left out');
  assert.match(snapshotText(['2026-01-15-120145']), /15\/01 12:01/);
  assert.equal(snapshotText([]), '');
  const text = shortText(20 * GB, [], t);
  assert.match(text, /wants 30 GB/);
  assert.match(text, /Grew most/);
  const src = readFileSync(new URL('../src/team/disk-tidy.ts', import.meta.url), 'utf8');
  assert.match(src, /void sampleIfDue\(/, 'measured daily, whatever the free space');
  assert.match(src, /shortText\(after, kept, await whatGrew\(/, 'the alert carries what grew');
});
