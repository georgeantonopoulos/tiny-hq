import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRESH_NOTE_MS, promptPending } from '../src/terminal/sessions.ts';

const HOOK = new URL('../hooks/office-waiting.mjs', import.meta.url).pathname;
const SID = '0e648a1e-aa6a-48ac-b0b4-447dfffcbe4d';

test('a permission prompt puts the room on hold for the owner until it is answered (Rosa sat on one twice with no sign)', () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-wait-'));
  const home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  const cwd = '/Users/x/Dev/proj';
  const tdir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  const transcript = (rows: object[]) => writeFileSync(join(tdir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const call = (id: string, command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

  // The hook prints nothing (the normal prompt shows) and notes the prompt.
  const out = execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'curl  -s http://127.0.0.1:4317/x' }, cwd }), encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: data } });
  assert.equal(out, '');
  const note = join(data, 'waiting', `${SID}.json`);
  assert.ok(existsSync(note));
  const now = Date.now();

  // Fresh, before the transcript shows the call: already waiting.
  transcript([]);
  assert.equal(promptPending(SID, cwd, data, home, now)?.kind, 'permission');
  // The call is there with no result: waiting, saying what for.
  transcript([call('t1', 'curl -s http://127.0.0.1:4317/x')]);
  assert.match(promptPending(SID, cwd, data, home, now + FRESH_NOTE_MS + 1)!.text, /Bash: curl/);
  // Answered: no longer waiting, and the note is cleared.
  transcript([call('t1', 'curl -s http://127.0.0.1:4317/x'), result('t1')]);
  assert.equal(promptPending(SID, cwd, data, home, now + FRESH_NOTE_MS + 1), undefined);
  assert.ok(!existsSync(note));
});

test('a room busy with its next command after the prompt is not shown as waiting', () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-wait-'));
  const home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  const cwd = '/Users/x/Dev/proj';
  const tdir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(tdir, { recursive: true });
  execFileSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'git push' } }), env: { ...process.env, CM_DATA_DIR: data } });
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'git push' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pnpm test' } }] } }, // running, no prompt
  ];
  writeFileSync(join(tdir, `${SID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(promptPending(SID, cwd, data, home, Date.now() + FRESH_NOTE_MS + 1), undefined);
  // Junk input: nothing noted, still silent.
  assert.equal(execFileSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: data } }), '');
});
