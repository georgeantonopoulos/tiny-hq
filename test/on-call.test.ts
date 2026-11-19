// On-call rooms: the office never reaches them by itself, so they cost nothing while nobody asks them
// anything. One declaration (config "onCallProjects", src/office/on-call.ts), checked where the office
// types into a session and where it picks rooms by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOnCall, mayReach, outOfCoffee } from '../src/office/on-call.ts';
import { loadConfig } from '../src/config.ts';

const office = realpathSync(new URL('..', import.meta.url).pathname);
const main = readFileSync(join(office, 'src/daemon/main.ts'), 'utf8');

test('isOnCall: the folder, a worktree or sub folder inside it; never a neighbour', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oncall-')));
  const admin = join(root, 'life-admin');
  mkdirSync(join(admin, '.claude', 'worktrees', 'w1'), { recursive: true });
  assert.equal(isOnCall(admin, [admin]), true);
  assert.equal(isOnCall(`${admin}/`, [admin]), true);
  assert.equal(isOnCall(join(admin, '.claude', 'worktrees', 'w1'), [admin]), true);
  assert.equal(isOnCall(`${admin}-2`, [admin]), false);
  assert.equal(isOnCall(root, [admin]), false);
  assert.equal(isOnCall(undefined, [admin]), false);
  assert.equal(isOnCall(admin, []), false);
});

test('isOnCall: a path spelled in another letter case still matches (the Mac disk ignores case)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oncall-case-')));
  const admin = join(root, 'life-admin');
  mkdirSync(admin);
  assert.equal(isOnCall(admin.replace('life-admin', 'Life-Admin'), [admin]), true);
  assert.equal(isOnCall(admin, [admin.toUpperCase()]), true);
});

test('mayReach: the owner and the nudge for their job get through; the office by itself does not', () => {
  const on = ['/Users/x/Dev/life-admin'];
  assert.equal(mayReach('/Users/x/Dev/life-admin', 'owner', on), true);
  assert.equal(mayReach('/Users/x/Dev/life-admin', 'job', on), true);
  assert.equal(mayReach('/Users/x/Dev/life-admin', 'office', on), false);
  assert.equal(mayReach('/Users/x/Dev/desk-lamp', 'office', on), true, 'other rooms are unchanged');
});

test('config: onCallProjects is read, and defaults to none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oncall-cfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify({ onCallProjects: ['/Users/x/Dev/life-admin', 'relative/no', 7] }));
  assert.deepEqual(loadConfig(p).onCallProjects, ['/Users/x/Dev/life-admin']);
  writeFileSync(p, '{}');
  assert.deepEqual(loadConfig(p).onCallProjects, []);
});

// Guard: a new automatic sender must go through typeInto, which checks the list before typing.
test('the office types into sessions only through typeInto, which refuses on-call rooms first', () => {
  const body = main.slice(main.indexOf('async function typeInto('), main.indexOf('async function typeIntoNow('));
  assert.match(body, /mayReach\(s\.cwd, owner \? 'owner' : job \? 'job' : 'office', config\.onCallProjects\)/);
  assert.ok(body.indexOf('mayReach(') < body.indexOf('typeIntoNow('), 'checked before anything is typed');
  // Raw terminal writes: the two inside typeIntoNow (line, Enter) and the /model pick when the owner opens a room.
  const writes = [...main.matchAll(/\bterm\.write\(/g)].length;
  assert.equal(writes, 3, 'a new term.write( bypasses the on-call check: send it through typeInto instead');
  assert.match(main, /term\.write\(`\/model \$\{model\}\\r`\)/);
});

test('only the nudge for a job the owner gave may reach an on-call room on its own', () => {
  const jobCalls = [...main.matchAll(/typeInto\(([^;\n]*), false, true\)/g)].map((m) => m[1]!);
  assert.equal(jobCalls.length, 1, `expected one job-nudge typeInto, found: ${jobCalls.join(' | ')}`);
  assert.match(jobCalls[0]!, /nudgeLine\(/);
  assert.doesNotMatch(jobCalls[0]!, /checkLine\(/, 'the hourly "has it happened" check is not a nudge');
});

test('rooms the office picks by itself (goal steps, the coffee room) leave on-call rooms out', () => {
  const goals = main.slice(main.indexOf('async function runGoals('), main.indexOf('pickRoom(cands'));
  assert.match(goals, /!isOnCall\((r\.project!\.path|c\.room), config\.onCallProjects\)/);
  const coffee = main.slice(main.indexOf('function coffeeRoom('), main.indexOf('applyPosts(s, posts'));
  assert.match(coffee, /const rooms = projectRooms\.filter\(\(r\) => !outOfCoffee\(r\.project!\.path, config\)\)/, 'a post from a private or on-call room is never filed');
  assert.match(coffee, /withoutRooms\(was, projectRooms\.filter\(\(r\) => outOfCoffee\(/, 'what they already shared comes off');
  const cli = readFileSync(new URL('../src/cli/coffee.ts', import.meta.url), 'utf8');
  assert.match(cli, /outOfCoffee\(room, config\)/, 'manager/coffee refuses them too');
});

// Private rooms (taxes, health, family): kept out of the coffee room like on-call ones.
test('outOfCoffee: on-call and private rooms (and their worktrees) are left out; others are not', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oncall-private-')));
  const admin = join(root, 'life-admin');
  const tax = join(root, 'tax');
  const app = join(root, 'garden-app');
  for (const d of [admin, tax, app]) mkdirSync(d);
  const c = { onCallProjects: [admin], privateProjects: [tax] };
  assert.equal(outOfCoffee(admin, c), true);
  assert.equal(outOfCoffee(tax, c), true);
  assert.equal(outOfCoffee(join(tax, '.claude', 'worktrees', 'w'), c), true);
  assert.equal(outOfCoffee(app, c), false);
  const cfg = join(root, 'config.json');
  writeFileSync(cfg, JSON.stringify({ privateProjects: [tax, 'not absolute'] }));
  assert.deepEqual(loadConfig(cfg).privateProjects, [tax]);
});

test('delegate refuses an on-call room unless the owner clicked or gave it an open job', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'oncall-dlg-')));
  const admin = join(root, 'life-admin');
  const other = join(root, 'other');
  mkdirSync(admin);
  mkdirSync(other);
  const cfg = join(root, 'config.json');
  const jobsFile = join(root, 'jobs.json');
  writeFileSync(cfg, JSON.stringify({ onCallProjects: [admin] }));
  const env = { ...process.env, CM_CONFIG_PATH: cfg, CM_JOBS_PATH: jobsFile, CM_CLAUDE_BIN: '/usr/bin/true', CM_DATA_DIR: root };
  const run = (folder: string) =>
    spawnSync('node', ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(office, 'src/cli/on-call.ts'), 'may-start', folder], { env, encoding: 'utf8' }).status;
  assert.equal(run(other), 0);
  assert.equal(run(admin), 5);
  const job = { id: 'tax', room: admin, title: 'Tax letter', done: 'Draft saved', status: 'active', createdAt: 1, updatedAt: 1 };
  writeFileSync(jobsFile, JSON.stringify({ jobs: [job] }));
  assert.equal(run(admin), 0);
  writeFileSync(jobsFile, JSON.stringify({ jobs: [{ ...job, status: 'done' }] }));
  assert.equal(run(admin), 5);
  // The script itself refuses before anything starts; the owner's own clicks (CM_FROM_OWNER) skip it.
  const dlg = (extra: Record<string, string>) => spawnSync(join(office, 'manager/delegate'), [admin, 'Room', 'hello'], { env: { ...env, ...extra }, encoding: 'utf8' }).status;
  assert.equal(dlg({}), 5);
  assert.notEqual(dlg({ CM_FROM_OWNER: '1' }), 5);
  assert.match(main, /'delegate'\), \[path, name, task\], \{ env: \{ \.\.\.env, CM_FROM_OWNER: '1' \}/);
  assert.match(main, /'delegate'\), \[folder, name, task\], \{ env: \{ \.\.\.env, CM_FROM_OWNER: '1' \}/);
});

test('the hourly check is not relayed through the manager to an on-call room with nobody in', () => {
  assert.match(main, /if \(d === 'check' && !s && isOnCall\(job\.room, config\.onCallProjects\)\) continue;/);
});

test('moving rooms onto a new Claude version types nothing into them', () => {
  const body = main.slice(main.indexOf('async function moveRoomsToNewClaude('), main.indexOf('// A room whose last turn was cut off'));
  assert.ok(body.includes('respawnSession('), 'uses claude respawn');
  assert.ok(!/typeInto|\.write\(/.test(body), 'a restart must not send a line: on-call rooms would get it');
});
