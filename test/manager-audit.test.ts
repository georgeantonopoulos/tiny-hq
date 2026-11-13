// The manager does less, and only what counts: no send-backs for a turn that changed nothing, usage
// measured rather than guessed, one question taken down at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain .mjs hook
import { turnDid } from '../hooks/manager-whiteboard.mjs';
import { roomOfFolder, tallyLines, weight } from '../src/cli/usage.ts';

const at = Date.parse('2026-11-13T10:00:00Z');
const said = (secs: number, content: unknown[]) => JSON.stringify({ type: 'assistant', timestamp: new Date(at + secs * 1000).toISOString(), message: { content } });

test('the whiteboard check leaves alone a turn that changed nothing', () => {
  assert.deepEqual(turnDid([said(1, [{ type: 'text', text: '(quiet)' }])], at), { acted: false, quiet: true });
  assert.equal(turnDid([said(1, [{ type: 'tool_use', name: 'Read', input: {} }]), said(2, [{ type: 'text', text: 'Nothing new.' }])], at).acted, false, 'only reading');
  assert.equal(turnDid([said(1, [{ type: 'tool_use', name: 'SendMessage', input: {} }]), said(2, [{ type: 'text', text: 'Asked the room.' }])], at).acted, true);
  assert.equal(turnDid([said(-5, [{ type: 'tool_use', name: 'Bash', input: {} }])], at).acted, false, 'before the turn started');
});

test('usage counts each step once, from the transcript usage fields', () => {
  const u = (id: string, secs: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(at + secs * 1000).toISOString(), requestId: 'r' + id, message: { id, usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } } });
  const t = tallyLines([u('a', 1), u('a', 1), u('b', 2), u('c', -10)], at);
  assert.equal(t.calls, 2, 'duplicate records and steps before the start are skipped');
  assert.equal(t.cacheRead, 2000);
  assert.equal(weight(t), 2 * (10 + 125 + 100 + 100));
  assert.equal(roomOfFolder('-Users-owner-Dev-garden-planner--claude-worktrees-sidecar'), 'Dev-garden-planner');
});

test("the manager's rules carry the do-less changes; a bare cancel is refused", () => {
  const g = readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8');
  for (const s of ['No relays', 'notify_when_idle', '{{cli}}/usage', 'Explain before you ask', 'Never cut work to save usage', 'a bare cancel is refused']) assert.ok(g.includes(s), s);
  assert.match(readFileSync(new URL('../src/cli/ask.ts', import.meta.url), 'utf8'), /if \(!id && !askedFor\) \{/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('manager/usage'));
});
