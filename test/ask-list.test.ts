// Fewer interruptions: a button that can wait comes up at the owner's 09:00 or 17:00 list, together
// with the others, and until then shows as a quiet clock. Posts, passwords, the camera, the
// manager's own questions and anything marked urgent show at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTimeAfter, shownNow, visibleAsks, waitsForList } from '../src/team/ask-list.ts';
import { addAsk, loadAsks, type Ask } from '../src/team/asks.ts';

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const noManager = () => false;
const ask = (why: string | undefined, createdAt: number, more: Partial<Ask> = {}): Ask => ({ id: `a${Math.random().toString(36).slice(2, 8)}`, folder: '/r/Site', question: 'Which logo?', createdAt, ...(why ? { why } : {}), ...more });

test('list times are 09:00 and 17:00, local', () => {
  assert.equal(listTimeAfter(at(20, 8, 59)), at(20, 9));
  assert.equal(listTimeAfter(at(20, 9)), at(20, 17));
  assert.equal(listTimeAfter(at(20, 17, 1)), at(21, 9));
});

test('what waits and what shows at once', () => {
  for (const why of ['choice', 'irreversible', 'pay', 'permission', 'hands']) assert.ok(waitsForList(ask(why, 0), noManager), why);
  for (const why of ['post', 'password', 'camera', 'POST']) assert.ok(!waitsForList(ask(why, 0), noManager), why);
  assert.ok(!waitsForList(ask('choice', 0, { urgent: 'the build is broken for everyone' }), noManager));
  assert.ok(!waitsForList(ask('choice', 0, { askedFor: true, sessionId: '0'.repeat(36) }), noManager), 'the manager over a room');
  assert.ok(!waitsForList(ask('choice', 0), (f) => f === '/r/Site'), "the manager's own");
  assert.ok(!waitsForList(ask('choice', 0, { trust: { name: 'X', task: 'y' } }), noManager), 'Trust and start');
});

test('a waiting button is due from its list time on, and asking again keeps its place', () => {
  const a = ask('choice', at(20, 10));
  assert.ok(!shownNow(a, at(20, 16, 59), noManager));
  assert.ok(shownNow(a, at(20, 17), noManager));
  assert.deepEqual(visibleAsks([a, ask('post', at(20, 10))], at(20, 11), noManager).map((x) => x.why), ['post']);
  // Asked at 16:50, asked again at 17:05: still on the 17:00 list.
  const first = addAsk([], '/r/Site', 'Which logo?', at(20, 16, 50), 'aaaaaa', undefined, undefined, undefined, false, undefined, { why: 'choice', tried: 'compared both on the phone' });
  const again = addAsk(first, '/r/Site', 'Which logo?', at(20, 17, 5), 'bbbbbb', undefined, undefined, undefined, false, undefined, { why: 'choice', tried: 'compared both on the phone' });
  assert.equal(again.length, 1);
  assert.equal(again[0]!.since, at(20, 16, 50));
  assert.ok(shownNow(again[0]!, at(20, 17, 6), noManager));
});

test('manager/ask tells the room its button waits, and --urgent shows it at once', () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'ask-list-')));
  const room = join(top, 'Site');
  const data = join(top, 'data');
  mkdirSync(room, { recursive: true });
  mkdirSync(data);
  execFileSync('git', ['-C', room, 'init', '-q']);
  writeFileSync(join(data, 'floor.json'), JSON.stringify({ seated: [room], away: [] }));
  const cli = new URL('../src/cli/ask.ts', import.meta.url).pathname;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', cli, ...args], { cwd: room, encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: data } });
  const held = run('Which logo goes on the site?', '--why', 'choice', '--tried', 'compared both on the phone', '--choices', 'Round', 'Square');
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.stdout, /waits for the owner's (09|17):00 list/);
  const now = run('Is the outage page right?', '--why', 'irreversible', '--tried', 'checked the text twice', '--urgent', 'the site is down for customers now');
  assert.equal(now.status, 0, now.stderr);
  assert.match(now.stdout, /The owner now sees a question mark/);
  assert.equal(run('Q?', '--why', 'choice', '--tried', 'checked the text twice', '--urgent', 'now').status, 2, 'urgent needs a reason');
  const saved = loadAsks(join(data, 'manager', 'asks.json'));
  assert.equal(saved.find((a) => a.question.startsWith('Is the outage'))?.urgent, 'the site is down for customers now');
});

// Unwired is the failure: the office must split due from held, and the page must draw the clock.
test('the button list is wired into the office', () => {
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  const open = main.slice(main.indexOf('function openAsks()'), main.indexOf('// Every answer the owner clicks is watched'));
  assert.match(open, /const due = visibleAsks\(all, Date\.now\(\), isManagerFolder\)/, 'openAsks splits due from held');
  assert.match(open, /oldestPerFolder\(all\.filter\(\(a\) => !due\.includes\(a\)\)\)\.map\(\(x\) => \(\{ \.\.\.x, held: listTimeAfter\(/, 'held buttons carry their list time');
  assert.match(open, /\.\.\.\(held \? \{ held \} : \{\}\)/, 'the page is told which buttons are held');
  const bubbles = readFileSync(new URL('../web/app/bubbles.ts', import.meta.url), 'utf8');
  assert.match(bubbles, /held \? '🕐' : '\?'/, 'a held button shows a clock, not a question mark');
  const page = readFileSync(new URL('../web/app/main.ts', import.meta.url), 'utf8');
  assert.match(page, /filter\(\(a\) => !a\.held\)\.map\(\(a\) => a\.id\)/, 'a held button makes no sound');
  assert.match(readFileSync(new URL('../src/cli/job.ts', import.meta.url), 'utf8'), /waitsForList\(mine/, 'job wait says when its button shows');
});

test("a job wait marked urgent keeps its urgency when it rides on the room's own waiting question", () => {
  const proof = { why: 'choice', tried: 'looked at both layouts' };
  let asks = addAsk([], '/r/garden', 'Which layout?', 1, 'roomaaaa', undefined, undefined, ['A', 'B'], false, undefined, proof);
  asks = addAsk(asks, '/r/garden', 'Pick the layout', 2, 'jobaaaaa', undefined, 'garden-7', undefined, false, undefined, { ...proof, urgent: 'the client demo is at 10:00' });
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.forJob, 'garden-7');
  assert.equal(asks[0]!.urgent, 'the client demo is at 10:00');
  assert.equal(waitsForList(asks[0]!, () => false), false);
});
