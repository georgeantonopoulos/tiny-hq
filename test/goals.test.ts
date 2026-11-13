import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGoals, setGoal } from '../src/team/goals.ts';
import { addAsk, loadAsks, oldestPerFolder, validAsk } from '../src/team/asks.ts';

// The office is proactive rather than idle: each room gets a goal the owner sets.
test('room goals: the owner sets, changes and clears a room goal; bad files and bad entries are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-goals-'));
  const path = join(dir, 'goals.json');
  assert.deepEqual(loadGoals(path), {});
  assert.equal(setGoal(path, '/g/Atlas', '  1.5 in the App Store,\n100 paying users ', 5), '1.5 in the App Store, 100 paying users');
  setGoal(path, '/g/Lumen', 'Linux build shipped', 6);
  assert.deepEqual(loadGoals(path)['/g/Atlas'], { goal: '1.5 in the App Store, 100 paying users', at: 5 });
  setGoal(path, '/g/Atlas', '200 paying users', 7);
  assert.equal(loadGoals(path)['/g/Atlas']!.goal, '200 paying users');
  assert.equal(setGoal(path, '/g/Lumen', '   '), '');
  assert.deepEqual(Object.keys(loadGoals(path)), ['/g/Atlas']);
  assert.equal(setGoal(path, '/g/x', 'y'.repeat(500)).length, 200);
  writeFileSync(path, JSON.stringify({ goals: { relative: { goal: 'no' }, '/ok': { goal: 'fine' }, '/empty': { goal: '' }, '/bad': 3 } }));
  assert.deepEqual(Object.keys(loadGoals(path)), ['/ok']);
  writeFileSync(path, 'not json');
  assert.deepEqual(loadGoals(path), {});
});

test("daily-brief next move: the manager's choice goes over the room's head and its answer comes back to the manager", () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-data-'));
  const room = realpathSync(mkdtempSync(join(tmpdir(), 'cm-room-')));
  const manager = '11111111-2222-4333-8444-555555555555';
  const cli = (...a: string[]) =>
    execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', new URL('../src/cli/ask.ts', import.meta.url).pathname, ...a], { env: { ...process.env, CM_DATA_DIR: data, CLAUDE_CODE_SESSION_ID: manager }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  cli('--room', room, 'Lumen: next move toward the Linux build?', '--why', 'choice', '--tried', 'Checked Lumen status and goal', '--choices', 'Build the tarball', 'Write the install page', 'Nothing now');
  const [a] = loadAsks(join(data, 'manager', 'asks.json'));
  assert.equal(a!.folder, room, 'shown over the room');
  assert.equal(a!.sessionId, manager, "The owner's pick goes back to the manager");
  assert.deepEqual(a!.options, ['Build the tarball', 'Write the install page', 'Nothing now']);
  assert.throws(() => cli('--room', join(room, 'nope'), 'Q?'), 'a folder that does not exist is refused');
  // The manager's instructions carry the step and the rule that only the owner sets goals.
  const g = readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8');
  assert.match(g, /One next move for every room with no open job/);
  assert.match(g, /Only the owner sets them/);
  // The manager cancelling their own next move leaves the room's own question alone.
  const asksFile = join(data, 'manager', 'asks.json');
  writeFileSync(asksFile, JSON.stringify({ asks: [...loadAsks(asksFile), { id: 'roomown1', folder: room, question: 'Ship it?', createdAt: 1, sessionId: '99999999-2222-4333-8444-555555555555' }] }));
  cli('--room', room, 'cancel');
  assert.deepEqual(loadAsks(asksFile).map((x) => x.id), ['roomown1']);
});

test("a next-move question over a room is never the room's own: a waiting job keeps its own button, and the newest question shows first", () => {
  const manager = '11111111-2222-4333-8444-555555555555';
  let asks = addAsk([], '/g/Lumen', 'Lumen: next move?', 1, 'mgrnext1', manager, undefined, ['A', 'B'], true);
  asks = addAsk(asks, '/g/Lumen', 'Approve the release', 2, 'jobaskaa', undefined, 'lumen-zip');
  // Otherwise the job's Approve rides on the manager's next-move question, and any pick restarted the job.
  assert.deepEqual(asks.map((a) => [a.id, a.forJob ?? a.job]).sort(), [['jobaskaa', 'lumen-zip'], ['mgrnext1', undefined]]);
  asks = addAsk(asks, '/g/Lumen', 'Use the old icon?', 3, 'roomqqqq');
  assert.equal(oldestPerFolder(asks.filter((a) => !a.job))[0]!.ask.id, 'roomqqqq', 'the newest question first');
  // The manager's newer question over a room isn't hidden behind the room's older one.
  asks = addAsk(asks, '/g/Lumen', 'Lumen: ship it?', 4, 'mgrnew01', manager, undefined, ['Yes', 'No'], true);
  assert.equal(oldestPerFolder(asks.filter((a) => !a.job))[0]!.ask.id, 'mgrnew01', "the manager's newer question shows");
  // The flag survives a save and load; it can't be set without an asking session.
  assert.equal(validAsk(JSON.parse(JSON.stringify(asks.find((a) => a.id === 'mgrnext1'))))!.askedFor, true);
  assert.equal(validAsk({ id: 'nosessio', folder: '/g', question: 'q?', askedFor: true })!.askedFor, undefined);
});
