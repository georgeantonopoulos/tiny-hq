import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { typedSince } from '../src/team/asks.ts';

const at = (iso: string) => Date.parse(iso);
const user = (text: string, ts: string, more: object = {}) => JSON.stringify({ type: 'user', timestamp: ts, origin: { kind: 'human' }, message: { content: text }, ...more });
const asked = at('2026-11-10T10:00:00Z');

test("The owner's own reply in the room's chat counts as answering its question", () => {
  // they answered Rex (merge PR #42) by chatting in Lumen's room.
  assert.equal(typedSince([user('yes merge 42, then tag it', '2026-11-10T10:05:00Z')], asked), 'yes merge 42, then tag it');
  // Spoken through the office mic counts too.
  assert.match(typedSince([user('The owner (spoken, through the office mic): merge it', '2026-11-10T10:05:00Z')], asked)!, /merge it/);
});

test("the office's own lines, notifications and earlier messages don't count", () => {
  const lines = [
    user('merge it', '2026-11-10T09:59:00Z'), // before the question
    user('[Office: job "x" is not done yet] Done means: …', '2026-11-10T10:01:00Z'),
    user('[Scheduled: Apple review] …', '2026-11-10T10:02:00Z'),
    user('The owner: yes, go ahead. (They clicked Approve …)', '2026-11-10T10:03:00Z'),
    user('The owner chose: "Merge it". (They picked it …)', '2026-11-10T10:03:30Z'),
    user('\n\n<pasted_content id="a48a">\n[Office: job …', '2026-11-10T10:04:00Z'),
    user('Job lumen-x: read /Users/g/.tiny-hq/manager/jobs/lumen-x.md first.', '2026-11-10T10:04:30Z'),
    user('The owner: drop job x (Lumen: y). They clicked × on it on your whiteboard: …', '2026-11-10T10:04:31Z'),
    user('The owner: action this from your whiteboard. Lumen: polish', '2026-11-10T10:04:32Z'),
    user("The owner: Lumen: polish. They had dismissed this on your whiteboard and has now brought it back", '2026-11-10T10:04:33Z'),
    user('The owner set the goal for Lumen: "x". (They typed it on your whiteboard.)', '2026-11-10T10:04:34Z'),
    user('<local-command-stdout>Set model to opus</local-command-stdout>', '2026-11-10T10:04:35Z'),
    user('<bash-input>ls</bash-input>', '2026-11-10T10:04:36Z'),
    user('[Request interrupted by user]', '2026-11-10T10:04:37Z'),
    user('<task-notification>…', '2026-11-10T10:04:40Z', { origin: { kind: 'task-notification' } }),
    user('Stop hook feedback: …', '2026-11-10T10:04:50Z', { isMeta: true }),
    user('from a subagent', '2026-11-10T10:04:55Z', { isSidechain: true }),
    JSON.stringify({ type: 'user', timestamp: '2026-11-10T10:05:00Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    'not json',
  ];
  assert.equal(typedSince(lines, asked), undefined);
});

test("Lumen's real conversations: only the owner's typed lines are picked out", () => {
  // A read-only look at the room's saved conversations, if they're on this Mac.
  const dir = join(homedir(), '.claude', 'projects', '-Users-someone-Dev-Lumen');
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs).slice(0, 3);
  } catch {
    return; // not on this machine
  }
  for (const f of files) {
    const found = typedSince(readFileSync(join(dir, f), 'utf8').split('\n'), 0);
    if (found) assert.doesNotMatch(found, /^\s*(\[Office|\[Scheduled|the owner: (yes|no)|the owner chose|<pasted_content|<task-notification)/, f);
  }
});
