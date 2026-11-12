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
