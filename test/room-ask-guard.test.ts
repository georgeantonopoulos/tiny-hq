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

// A refused button followed by the same question in chat used to count as asked; so did the words
// "manager/ask" quoted in a note. A merge left waiting on the owner with no "?" is a question too.
test('a refused, help or quoted manager/ask is not a button; a line that leaves something waiting on the owner counts', () => {
  const data = mkdtempSync(join(tmpdir(), 'rag-'));
  mkdirSync(join(data, 'tags'));
  const room = '/Users/someone/Dev/notes';
  writeFileSync(tagFile(room, data), 'tag');
  const user = line({ type: 'user', message: { content: 'carry on' } });
  const call = (id: string, command: string) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id: string, content: string) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const q = 'Should I run it on the live vault?';
  const write = (name: string, rows: string[]) => {
    const t = join(data, name);
    writeFileSync(t, [user, ...rows].join('\n'));
    return t;
  };
  const cases: [string, string[], boolean][] = [
    ['refused', [call('a', '~/.tiny-hq/app/manager/ask "Merge PR 21?" --why choice'), result('a', 'No button for the owner.\nNo Merge button.')], true],
    ['refused wait', [call('f', '~/.tiny-hq/app/manager/job wait x "Run it?" --why choice'), result('f', 'Not waiting on the owner: x stays active.')], true],
    ['help', [call('b', '~/.tiny-hq/app/manager/ask --help | head'), result('b', 'usage')], true],
    ['quoted', [call('c', '~/.tiny-hq/app/manager/evening add "merged (manager/ask refuses Merge buttons)"'), result('c', 'Added')], true],
    ['errored', [call('d', '~/.tiny-hq/app/manager/ask "Run it?" --why irreversible'), line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'd', is_error: true, content: 'Exit code 2' }] } })], true],
    ['went up', [call('e', '~/.tiny-hq/app/manager/ask "Run it?" --why irreversible --tried "x"'), result('e', 'The owner now sees a question mark over your head')], false],
  ];
  for (const [name, rows, sentBack] of cases) {
    const out = run(data, room, write(`${name}.jsonl`, rows), [], q);
    if (sentBack) assert.match(out, /"decision":"block"/, name);
    else assert.equal(out, '', name);
  }
  const waits = 'The only thing left on #16 is your merge, which puts the new title live on the site.';
  assert.match(run(data, room, write('waits.jsonl', []), [], waits), /"decision":"block"/);
  assert.equal(run(data, room, write('nothing.jsonl', []), [], 'Done. Nothing is waiting on you.'), '');
});
