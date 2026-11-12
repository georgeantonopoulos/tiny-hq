import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAsk, afterCancel, roomsOwnQuestion, type Ask } from '../src/team/asks.ts';

const MANAGER = '11111111-2222-3333-4444-555555555555';
const PIXEL = '66666666-7777-8888-9999-000000000000';
const ROOM = '/Users/g/Dev/Watch Face';
const pixels = addAsk([], `${ROOM}/.claude/worktrees/pebble-beta-test-updates`, 'Ship Pebble 1.0.1?', 1, 'roomask1', PIXEL)[0]!;
const managers = addAsk([], ROOM, 'Pebble 1.0.1: ship it?', 2, 'mgrask01', MANAGER, undefined, ['Ship', 'Not yet'], true)[0]!;

test("a room's own question, in its folder or a worktree, is found; the manager's over it is not the room's own", () => {
  assert.equal(roomsOwnQuestion([pixels], ROOM)?.id, 'roomask1');
  assert.equal(roomsOwnQuestion([managers], ROOM), undefined);
  assert.equal(roomsOwnQuestion([pixels], '/Users/g/Dev/Google'), undefined, 'a folder that merely starts the same is another room');
});

test("ask cancel from the manager's folder takes down their questions over rooms too; the rooms' own stay", () => {
  const all: Ask[] = [pixels, managers];
  assert.deepEqual(afterCancel(all, '/Users/g/Dev/tiny-hq/manager', MANAGER, false).map((a) => a.id), ['roomask1']);
  // --room cancel: only their own over that room.
  assert.deepEqual(afterCancel(all, ROOM, MANAGER, true).map((a) => a.id), ['roomask1']);
  // A room cancelling its own leaves the manager's alone.
  assert.deepEqual(afterCancel(all, `${ROOM}/.claude/worktrees/pebble-beta-test-updates`, PIXEL, false).map((a) => a.id), ['mgrask01']);
});

test('ask --room is refused while the room has its own question up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-askroom-'));
  const room = join(dir, 'Watch Face');
  mkdirSync(join(room, '.claude', 'worktrees', 'x'), { recursive: true });
  mkdirSync(join(dir, 'manager'));
  const real = realpathSync(room);
  writeFileSync(join(dir, 'manager', 'asks.json'), JSON.stringify({ asks: [{ ...pixels, folder: `${real}/.claude/worktrees/x` }] }));
  const cli = (...a: string[]) =>
    execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', new URL('../src/cli/ask.ts', import.meta.url).pathname, ...a], {
      env: { ...process.env, CM_DATA_DIR: dir, CLAUDE_CODE_SESSION_ID: MANAGER },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  assert.throws(() => cli('--room', room, 'Ship it?', '--why', 'choice', '--tried', 'checked the emulator run', '--choices', 'Ship', 'Not yet'), /already has its own question/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'manager', 'asks.json'), 'utf8')).asks.length, 1);
});

// A merge button asked in one worktree used to go down when the same session cancelled in another,
// and a chat line that only mentioned the project took it down as an "answer".
test('ask cancel takes one question by id, or only this folder\'s; unrelated chat lines are not answers', async () => {
  const { answersAsk } = await import('../src/team/asks.ts');
  const ROOM_S = 'ce9a86ac-887b-4110-af74-c88217d4e935';
  const wt = (n: string) => `/Users/g/Dev/Lumen/.claude/worktrees/${n}`;
  let all = addAsk([], wt('linux-ci-crash'), 'Lumen: merge PR #45?', 1, 'mergeaa45', ROOM_S, undefined, ['Merge #45', 'Wait']);
  all = addAsk(all, wt('sidecar-proto'), 'May I post on #44?', 2, 'postaa44', ROOM_S);
  assert.deepEqual(afterCancel(all, wt('sidecar-proto'), ROOM_S, false).map((a) => a.id), ['mergeaa45']);
  assert.deepEqual(afterCancel(all, wt('sidecar-proto'), ROOM_S, false, 'postaa44').map((a) => a.id), ['mergeaa45']);
  assert.deepEqual(afterCancel(all, '/Users/g/Dev/Other', undefined, false, 'mergeaa45').map((a) => a.id), ['mergeaa45', 'postaa44']); // not yours
  const merge = all[0]!;
  assert.equal(answersAsk('Pip, do I have an open lumen on my Mac? Ready to test', merge), false);
  assert.equal(answersAsk('11 y\n\n<pasted_content id="x">Job: Lumen Linux CI crash merge tests loader parallel</pasted_content id="x">\n[Office: job "Lumen: fix colour bugs" ...]', merge), false);
  for (const t of ['yes', 'Merge #45', 'go ahead', 'not yet, wait for CI', 'merge it', 'ok do #45 now'])
    assert.equal(answersAsk(t, merge), true, t);
});

// Job wait used to put a second "tap Trust and start" button next to the
// office's Trust-and-start button, and the manager couldn't cancel it from its folder.
test('a job wait rides on a pending Trust-and-start button, and the manager can cancel a job button by id', async () => {
  const { oneQuestionPerJob, validAsk } = await import('../src/team/asks.ts');
  const room = '/Users/g/Dev/learning-adventures';
  const trust = validAsk({ id: 'jgyhz98g', folder: room, question: 'Trust and start?', createdAt: 1, sessionId: MANAGER, askedFor: true, trust: { name: 'Garden Planner', task: 'build it' } })!;
  const wait = validAsk({ id: '36x7btz9', folder: room, question: 'Tap Trust and start', createdAt: 2, job: 'learning-adventures', why: 'permission', tried: 't' })!;
  const folded = oneQuestionPerJob([trust, wait]);
  assert.deepEqual(folded.map((a) => [a.id, a.forJob]), [['jgyhz98g', 'learning-adventures']]);
  assert.equal(validAsk(JSON.parse(JSON.stringify(folded[0])))!.forJob, 'learning-adventures');
  // The manager's folder takes down a job button by id; another room can't.
  assert.deepEqual(afterCancel([trust, wait], '/Users/g/Dev/tiny-hq/manager', MANAGER, false, '36x7btz9', true).map((a) => a.id), ['jgyhz98g']);
  assert.equal(afterCancel([trust, wait], '/Users/g/Dev/other', undefined, false, '36x7btz9').length, 2);
});
