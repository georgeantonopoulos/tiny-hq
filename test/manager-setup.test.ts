import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extraManagers, lastAction, waitingOn } from '../src/terminal/sessions.ts';
import { renderStatus } from '../src/terminal/status.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('only one manager: stale sessions with no running process are retired too, and rooms get a fixed address', () => {
  const manager = '/nonexistent/Dev/tiny-hq/manager';
  // `claude agents` also lists dead blocked sessions; they still carry the name "Manager".
  const all = [
    { id: 'aaaaaaaa', realCwd: manager, status: 'idle' },
    { id: 'bbbbbbbb', realCwd: manager }, // stale: no pid, no status
    { id: 'cccccccc', realCwd: manager, status: 'busy' },
  ];
  assert.deepEqual(extraManagers(all, manager, 'aaaaaaaa'), ['bbbbbbbb']);
  // Guard: the daemon retires from the full list (not only running ones) and publishes the manager's address; the brief points rooms at it.
  const main = read('../src/daemon/main.ts');
  assert.match(main, /const all = await allSessions\(\);[\s\S]{0,200}extraManagers\(all,/);
  assert.match(main, /manager-address\.txt/);
  const brief = read('../agents/worker-brief.md');
  assert.match(brief, /\{\{managerAddress\}\}/, "the room brief names where the manager's fixed address is");
  assert.match(brief, /only when the task finishes or fails/);
  assert.doesNotMatch(brief, /progress note after each phase/, 'progress goes in job notes, not messages');
  assert.match(brief, /bare claim/, 'rooms never state "The owner approved" without a source');
  assert.match(read('../manager/delegate'), /job note after each phase/);
  assert.equal(JSON.parse(read('../manager/.claude/settings.json')).autoCompactWindow, 200000, "the manager's conversation compacts at 200k");
});

test('a blocked session says what it waits on; last action reads as plain words, not escape codes', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-wait-'));
  const cwd = '/Users/x/Dev/Dew';
  const folder = join(home, '.claude', 'projects', '-Users-x-Dev-Dew');
  mkdirSync(folder, { recursive: true });
  const put = (id: string, recs: unknown[]) => writeFileSync(join(folder, `${id}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const asst = (content: unknown[], t = 't') => ({ type: 'assistant', timestamp: t, message: { content } });
  const result = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const perm = '31111111-2222-4333-8444-555555555555';
  put(perm, [asst([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }]), result('a'), asst([{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: '\x1b[31mrm -rf build\x1b[0m' } }])]);
  assert.deepEqual(waitingOn(perm, cwd, home), { kind: 'permission', text: 'permission to use Bash: rm -rf build' });
  assert.deepEqual(lastAction(perm, cwd, home), { text: 'Bash: rm -rf build', at: 't' });
  const ask = '41111111-2222-4333-8444-555555555555';
  put(ask, [asst([{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?' }] } }])]);
  assert.deepEqual(waitingOn(ask, cwd, home), { kind: 'question', text: 'Ship it?' });
  const none = '51111111-2222-4333-8444-555555555555';
  put(none, [asst([{ type: 'tool_use', id: 'z', name: 'Bash', input: { command: 'ls' } }]), result('z'), asst([{ type: 'text', text: 'Done. Over to you.' }])]);
  assert.equal(waitingOn(none, cwd, home).kind, 'unknown');
  assert.equal(lastAction(none, cwd, home)?.text, 'said: Done. Over to you.');
  assert.equal(waitingOn('99999999-2222-4333-8444-555555555555', cwd, home).kind, 'unknown', 'no transcript');
});

test("The manager's status page: blocked rooms say what they wait on; the owner's own and stale sessions are listed", () => {
  const text = renderStatus(
    [
      { id: 'aaaaaaaa', name: 'Pebble Play check', status: 'idle', state: 'blocked', alive: true, room: 'Pebble', waiting: { kind: 'permission', text: 'permission to use Bash: rm x' } },
      { id: 'bbbbbbbb', name: 'Lumen job', status: 'busy', state: 'working', alive: true, room: 'Lumen', action: 'Edit: a.ts' },
      { id: 'cccccccc', name: 'tiny-hq-cc', kind: 'interactive', status: 'idle', alive: true, room: 'Website' },
      { id: 'dddddddd', name: 'Old Lumen', state: 'blocked', alive: false, room: 'Lumen', startedAt: 1000 },
      // Stuck on "Login expired": Claude Code says blocked, the transcript has no prompt, so the office says done.
      { id: 'eeeeeeee', name: 'Newest branch PR comments', kind: 'background', state: 'done', claudeState: 'blocked', alive: true, startedAt: 1000 },
    ],
    ['Pebble', 'Lumen', 'Website'],
    1000 + 3 * 86_400_000,
  );
  // The owner's own session in a room is how the manager reaches that room: by its exact name.
  assert.match(text, /## Website\n- \*\*tiny-hq-cc\*\* \(cccccccc\): idle · the owner's own session[^\n]*SendMessage to `tiny-hq-cc`/);
  assert.match(text, /couldn't close them: an office fault \(run `tiny-hq doctor`\), not the owner's job[^\n]*\n(- [^\n]*\n)*- Newest branch PR comments \(eeeeeeee\)/);
  assert.match(text, /BLOCKED · waiting for the owner to approve: permission to use Bash: rm x/);
  assert.match(text, /\*\*Lumen job\*\* \(bbbbbbbb\): working · last action: Edit: a\.ts · SendMessage to `Lumen job`/);
  assert.match(text, /The owner's own sessions[^\n]*\n- tiny-hq-cc \(cccccccc\)/);
  assert.match(text, /Old Lumen \(dddddddd\) · its process is gone · started 3 days ago/);
});

test("The manager's instructions keep the permanent Lessons, the watch rule and the approval rule", () => {
  const g = read('../manager/CLAUDE.template.md');
  assert.match(g, /## Lessons \(permanent: never prune/);
  assert.match(g, /Awaited replies get a watch/);
  assert.match(g, /fix the setup, not just the case/);
  assert.match(g, /same turn the waiting starts/);
  assert.match(g, /Real approvals/);
  assert.match(g, /status\.md/);
  // Quiet turns: the hook, the job check and the manager's rule all use the reply the office hides.
  assert.match(g, /reply with exactly `\(quiet\)`/);
});

test("the office stamps the Updated line of each project a turn was about, and never sends the manager back", async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const settings = JSON.parse(readFileSync(new URL('../manager/.claude/settings.json', import.meta.url), 'utf8'));
  assert.match(JSON.stringify(settings.hooks.Stop), /manager-whiteboard\.mjs/, 'wired into the manager\'s settings');
  const dir = mkdtempSync(join(tmpdir(), 'manager-wb-'));
  mkdirSync(join(dir, 'manager'));
  const notebook = join(dir, 'manager', 'notebook.md');
  const before = '# Notes\n\n## Atlas (Ada Lovelace)\n- Next: release\n- Updated: 2026-11-01\n\n## Garden (Grace Hopper)\n- Next: beds\n\n## Lumen (Alan Turing 2)\n- Next: upload\n- Updated: 2026-11-02\n\n## Website 2 (Edsger Dijkstra)\n- Updated: 2026-11-03\n';
  writeFileSync(notebook, before);
  const transcript = join(dir, 't.jsonl');
  const prompt = (at: string, text: string) => JSON.stringify({ type: 'user', timestamp: at, message: { content: text } });
  const toolResult = JSON.stringify({ type: 'user', timestamp: '2026-11-08T10:00:05Z', message: { content: [{ type: 'tool_result', content: 'Alan Turing 2 is idle' }] } });
  const acted = JSON.stringify({ type: 'assistant', timestamp: '2026-11-08T10:00:04Z', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { message: 'Thanks.\nGrace Hopper, carry on' } }] } });
  // Only reading, or ending "(quiet)": nothing changed, so the notebook is left alone.
  const readOnly = JSON.stringify({ type: 'assistant', timestamp: '2026-11-08T10:00:04Z', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
  const quiet = JSON.stringify({ type: 'assistant', timestamp: '2026-11-08T10:00:06Z', message: { content: [{ type: 'text', text: '(quiet)' }] } });
  const old = prompt('2026-11-07T09:00:00Z', 'Alan Turing: old news');
  const start = prompt('2026-11-08T10:00:00Z', 'Ada Lovelace: done, and Website 1 is live');
  const run = (extra: object = {}) => execFileSync(process.execPath, [new URL('../hooks/manager-whiteboard.mjs', import.meta.url).pathname], { input: JSON.stringify({ transcript_path: transcript, ...extra }), env: { ...process.env, CM_DATA_DIR: dir } }).toString();
  utimesSync(notebook, new Date('2026-11-08T09:00:00Z'), new Date('2026-11-08T09:00:00Z')); // before the turn
  writeFileSync(transcript, [old, start, readOnly, toolResult].join('\n') + '\n');
  assert.equal(run(), '');
  assert.equal(readFileSync(notebook, 'utf8'), before, 'a turn that only read leaves it alone');
  writeFileSync(transcript, [old, start, acted, toolResult, quiet].join('\n') + '\n');
  assert.equal(run(), '');
  assert.equal(readFileSync(notebook, 'utf8'), before, 'a turn that ended "(quiet)" leaves it alone');
  writeFileSync(transcript, [old, start, acted, toolResult].join('\n') + '\n');
  assert.equal(run(), '', 'never sends them back');
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(
    readFileSync(notebook, 'utf8'),
    `# Notes\n\n## Atlas (Ada Lovelace)\n- Next: release\n- Updated: ${today}\n\n## Garden (Grace Hopper)\n- Next: beds\n- Updated: ${today}\n\n## Lumen (Alan Turing 2)\n- Next: upload\n- Updated: 2026-11-02\n\n## Website 2 (Edsger Dijkstra)\n- Updated: 2026-11-03\n`,
    'stamped: Atlas (named in the message that started the turn), Garden (in their tool call, line added); Lumen only in a tool result and an earlier turn; Website 2 not, though Website 1 was named',
  );
  assert.match(readFileSync(join(dir, 'manager', 'whiteboard-stamps.log'), 'utf8'), /^\S+Z Atlas \(Ada Lovelace\) \| Garden \(Grace Hopper\)\n$/, 'each stamp leaves a line');
  // A stop after a block, or a notebook the manager wrote during the turn: left as it is.
  writeFileSync(notebook, before);
  assert.equal(run({ stop_hook_active: true }), '');
  assert.equal(readFileSync(notebook, 'utf8'), before);
  utimesSync(notebook, new Date('2026-11-08T10:00:03Z'), new Date('2026-11-08T10:00:03Z')); // written during the turn
  assert.equal(run(), '');
  assert.equal(readFileSync(notebook, 'utf8'), before);
  assert.equal(execFileSync(process.execPath, [new URL('../hooks/manager-whiteboard.mjs', import.meta.url).pathname], { input: 'not json' }).toString(), '', 'never blocks on bad input');
});
