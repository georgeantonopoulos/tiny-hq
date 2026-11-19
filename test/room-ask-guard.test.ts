// A room asked the owner "A, B or C?" in its chat, and no question mark showed over its head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs hook
import { isManager, isRoom, MANAGER_REASON, REASON, tagFile } from '../hooks/room-ask-guard.mjs';

const HOOK = new URL('../hooks/room-ask-guard.mjs', import.meta.url).pathname;
const line = (o: object) => JSON.stringify(o);
const run = (data: string, cwd: string, transcript: string, args: string[] = [], last?: string) =>
  spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify({ transcript_path: transcript, cwd, last_assistant_message: last }), env: { ...process.env, CM_DATA_DIR: data, CLAUDE_PROJECT_DIR: cwd }, encoding: 'utf8' }).stdout;

test('rooms are sessions with an office name tag, worktrees included, never the manager', () => {
  const data = mkdtempSync(join(tmpdir(), 'rag-'));
  mkdirSync(join(data, 'tags'));
  writeFileSync(tagFile('/Users/owner/Dev/garden-planner', data), 'tag');
  assert.equal(isRoom('/Users/owner/Dev/garden-planner', data), true);
  assert.equal(isRoom('/Users/owner/Dev/garden-planner/.claude/worktrees/x', data), true);
  assert.equal(isRoom('/Users/owner/Dev/Other', data), false);
  writeFileSync(tagFile('/Users/owner/.tiny-hq/app/manager', data), 'tag');
  assert.equal(isRoom('/Users/owner/.tiny-hq/app/manager', data), false);
});

test('a room that asks the owner in chat without a button is sent back once; with a button it is not', () => {
  const data = mkdtempSync(join(tmpdir(), 'rag-'));
  mkdirSync(join(data, 'tags'));
  const room = '/Users/owner/Dev/garden-planner';
  writeFileSync(tagFile(room, data), 'tag');
  const t = join(data, 't.jsonl');
  const user = line({ type: 'user', message: { content: 'what next?' } });
  const ask = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Which way should the importer read the files: A, B or C?' }] } });
  writeFileSync(t, [user, ask].join('\n'));
  assert.match(run(data, room, t), /"decision":"block"/);
  assert.equal(run(data, room, t), '', 'only once per turn');
  assert.equal(run(data, '/Users/owner/Dev/NotARoom', t), '', 'not a room');
  const withButton = line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: '~/.tiny-hq/app/manager/ask "Which way?" --why choice' } }] } });
  const t2 = join(data, 't2.jsonl');
  writeFileSync(t2, [user, withButton, ask].join('\n'));
  assert.equal(run(data, room, t2), '');
  const plain = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. The build passed.' }] } });
  const t3 = join(data, 't3.jsonl');
  writeFileSync(t3, [user, plain].join('\n'));
  assert.equal(run(data, room, t3), '');
});

test("one check for everyone: the manager's own settings run it with --manager and get the manager's wording", () => {
  const data = mkdtempSync(join(tmpdir(), 'rag-'));
  const manager = '/Users/owner/.tiny-hq/app/manager';
  assert.equal(isManager(manager), true);
  assert.equal(isManager('/Users/owner/Dev/garden-planner'), false);
  const t = join(data, 't.jsonl');
  const user = line({ type: 'user', message: { content: 'what next?' } });
  const ask = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Shall I start the garden room on it?' }] } });
  writeFileSync(t, [user, ask].join('\n'));
  assert.equal(run(data, manager, t), '', 'the global run leaves the manager to its own settings: never twice');
  const out = run(data, manager, t, ['--manager']);
  assert.equal(JSON.parse(out).reason, MANAGER_REASON);
  assert.match(MANAGER_REASON, /--why <post\|pay\|irreversible\|choice\|/, 'the manager may put a choice on a button');
  assert.match(REASON, /\|choice\|/, 'a room may too, with --choices');
  assert.equal(run(data, '/Users/owner/Dev/garden-planner', t, ['--manager']), '', '--manager only checks the manager');
});

// The hook can run before Claude Code writes the final reply to the chat file, so it read an older
// reply and let room questions through. The reply handed to the hook comes first.
test('the reply Claude Code hands the hook counts even when the chat file does not hold it yet', () => {
  const data = mkdtempSync(join(tmpdir(), 'rag-'));
  mkdirSync(join(data, 'tags'));
  const room = '/Users/owner/Dev/desk-lamp';
  writeFileSync(tagFile(room, data), 'tag');
  const user = line({ type: 'user', message: { content: 'is the lamp fixed' } });
  const earlier = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the lamp now.' }] } });
  const t = join(data, 't.jsonl');
  writeFileSync(t, [user, earlier].join('\n'));
  assert.match(run(data, room, t, [], 'Did the table lamp flicker like a fire, or stay steady?'), /"decision":"block"/);
  const t2 = join(data, 't2.jsonl');
  writeFileSync(t2, [user, earlier].join('\n'));
  assert.equal(run(data, room, t2, [], 'Done. The lamp is fixed.'), '', 'a plain statement is left alone');
  const button = line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: '~/.tiny-hq/app/manager/ask "Flicker?" --why choice' } }] } });
  const t3 = join(data, 't3.jsonl');
  writeFileSync(t3, [user, button].join('\n'));
  assert.equal(run(data, room, t3, [], 'Did it flicker? (also on the button)'), '', 'a button this turn still counts');
});
