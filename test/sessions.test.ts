import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in for `claude` that records how it was called.
const dir = mkdtempSync(join(tmpdir(), 'cm-sessions-'));
const calls = join(dir, 'calls.txt');
const fake = join(dir, 'claude');
writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" "--" "CM_SECRET=$CM_SECRET" >> '${calls}'\necho 'backgrounded · abcdef12 · test'\n`);
chmodSync(fake, 0o755);
process.env.CM_CLAUDE_BIN = fake;
process.env.CM_SECRET = 'office-only';

test('sessions start as plain `claude --bg` in the folder; office settings never leak', async () => {
  const { startSession } = await import('../src/terminal/sessions.ts');
  const s = await startSession(dir, 'My App!$(x)', 'fix the tests');
  assert.equal(s.id, 'abcdef12');
  const lines = readFileSync(calls, 'utf8').trim().split('\n');
  const first = lines.slice(0, lines.indexOf('--') + 2);
  assert.equal(first[0]?.endsWith(dir.split('/').pop()!), true, 'runs in the project folder');
  assert.deepEqual(first.slice(1, 5), ['--bg', '-n', 'My Appx', 'fix the tests'], 'no other flags; the name is cleaned');
  assert.ok(!first.includes('--append-system-prompt'));
  assert.ok(first.includes('CM_SECRET='), "the office's own variables don't reach the session");
  // A room's brief and model go in as flags; nothing else changes.
  writeFileSync(calls, '');
  await startSession(dir, 'Lamp', 'look around', 'sonnet', 'You are Gilda.');
  const second = readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(second.slice(1, 9), ['--bg', '-n', 'Lamp', '--model', 'sonnet', '--append-system-prompt', 'You are Gilda.', 'look around']);
});

test("The manager's bubble: the last thing they said comes from their saved transcript", async () => {
  const { lastSaid } = await import('../src/terminal/sessions.ts');
  const { mkdirSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  const cwd = '/Users/x/Dev/tiny-hq/manager';
  const id = '11111111-2222-4333-8444-555555555555';
  const folder = join(home, '.claude', 'projects', '-Users-x-Dev-tiny-hq-manager');
  mkdirSync(folder, { recursive: true });
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    join(folder, `${id}.jsonl`),
    [
      line({ type: 'user', message: { content: 'what is going on' } }),
      line({ type: 'assistant', timestamp: 't1', message: { content: [{ type: 'text', text: 'First.' }] } }),
      line({ type: 'assistant', timestamp: 't2', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      line({ type: 'assistant', timestamp: 't3', message: { content: [{ type: 'text', text: 'Lumen is green. I accept full credit.' }] } }),
      // A turn where nothing changed ("Nothing new" bubbles all day): no new bubble.
      line({ type: 'user', message: { content: '[Cross-session idle notice] Rex is idle' } }),
      line({ type: 'assistant', timestamp: 't4', message: { content: [{ type: 'text', text: '(quiet)' }] } }),
      '{"type":"assistant", broken',
    ].join('\n'),
  );
  assert.deepEqual(lastSaid(id, cwd, home), { text: 'Lumen is green. I accept full credit.', at: 't3' });
  assert.equal(lastSaid('not-an-id', cwd, home), undefined);
  assert.equal(lastSaid('99999999-2222-4333-8444-555555555555', cwd, home), undefined, 'no transcript yet');
});

test("a project's report to the manager (SendMessage) shows as what it said", async () => {
  const { lastSaid } = await import('../src/terminal/sessions.ts');
  const { mkdirSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  const id = '21111111-2222-4333-8444-555555555555';
  const folder = join(home, '.claude', 'projects', '-Users-x-Dev-Lumen');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${id}.jsonl`),
    JSON.stringify({ type: 'assistant', timestamp: 't9', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'Manager [550312]', message: 'Superseded: already on main, nothing to push.' } }] } }),
  );
  assert.deepEqual(lastSaid(id, '/Users/x/Dev/Lumen', home), { text: 'Superseded: already on main, nothing to push.', at: 't9', to: 'Manager' }, 'who it went to, without the session handle');
});

test('a session in a worktree inside the project counts as that room; other subfolders do not', async () => {
  const { worksIn } = await import('../src/terminal/sessions.ts');
  const p = '/nonexistent/Dev/tiny-hq';
  assert.equal(worksIn(p, p), true);
  assert.equal(worksIn(`${p}/.claude/worktrees/watch-face-room`, p), true, 'EnterWorktree moves a session here');
  assert.equal(worksIn(`${p}/manager`, p), false, "The manager's folder is not the project room");
  assert.equal(worksIn(`${p}-other`, p), false);
  assert.equal(worksIn(`${p}/.claude/worktrees-x`, p), false);
});

test('the most recently used session is the one a room joins, by its last real message', async () => {
  const { lastActiveAt } = await import('../src/terminal/sessions.ts');
  const { mkdirSync, utimesSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'cm-active-'));
  const cwd = '/Users/test/Dev/Proj';
  const folder = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  const busy = { sessionId: '11111111-1111-1111-1111-111111111111', cwd, startedAt: 1000 };
  const old = { sessionId: '22222222-2222-2222-2222-222222222222', cwd, startedAt: 2000 };
  const msg = (type: string, at: string) => JSON.stringify({ type, timestamp: at, message: { content: [] } });
  writeFileSync(join(folder, `${busy.sessionId}.jsonl`), [msg('user', '2026-11-07T10:50:00Z'), msg('assistant', '2026-11-07T10:55:00Z')].join('\n') + '\n');
  // The old one: last real message two days ago, then a housekeeping line written just now.
  writeFileSync(join(folder, `${old.sessionId}.jsonl`), [msg('assistant', '2026-11-05T12:17:00Z'), JSON.stringify({ type: 'system', subtype: 'away_summary', content: 'x' })].join('\n') + '\n');
  utimesSync(join(folder, `${old.sessionId}.jsonl`), new Date(), new Date());
  assert.equal([old, busy].sort((a, b) => lastActiveAt(b, home) - lastActiveAt(a, home))[0], busy);
  assert.equal(lastActiveAt({ sessionId: '33333333-3333-3333-3333-333333333333', cwd, startedAt: 42 }, home), 42, 'no transcript yet: when it started');
});

test('only one manager: every other idle session in their folder is stopped, busy ones wait', async () => {
  const { extraManagers } = await import('../src/terminal/sessions.ts');
  const manager = '/nonexistent/Dev/tiny-hq/manager';
  const live = [
    { id: 'aaaaaaaa', realCwd: manager, status: 'idle' }, // the one kept
    { id: 'bbbbbbbb', realCwd: manager, status: 'idle' },
    { id: 'cccccccc', realCwd: manager, status: 'busy' },
    { id: 'dddddddd', realCwd: `${manager}/.claude/worktrees/x`, status: 'idle' },
    { id: 'eeeeeeee', realCwd: '/nonexistent/Dev/tiny-hq', status: 'idle' }, // Rosa, not the manager
  ];
  assert.deepEqual(extraManagers(live, manager, 'aaaaaaaa'), ['bbbbbbbb', 'dddddddd']);
});

test('one session per room: the newest stays, older idle ones go, busy or held ones wait', async () => {
  const { extraRoomSessions } = await import('../src/terminal/sessions.ts');
  const room = '/nonexistent/room';
  const s = (id: string, startedAt: number, status = 'idle', realCwd = '/nonexistent/room') => ({ id, realCwd, status, startedAt });
  assert.deepEqual(extraRoomSessions([s('old', 1), s('new', 2)], room), ['old']);
  assert.deepEqual(extraRoomSessions([s('old', 1, 'busy'), s('new', 2)], room), []);
  assert.deepEqual(extraRoomSessions([s('old', 1), s('new', 2)], room, (x) => x.id === 'old'), []);
  assert.deepEqual(extraRoomSessions([s('wt', 1, 'idle', '/nonexistent/room/.claude/worktrees/x'), s('new', 2)], room), ['wt']);
  assert.deepEqual(extraRoomSessions([s('only', 1)], room), []);
  assert.deepEqual(extraRoomSessions([s('other', 1, 'idle', '/var'), s('new', 2)], room), []);
});

test("a long-attached screen stays ready after its switch to full screen scrolls out of the backlog", async () => {
  const { trackScreen } = await import('../src/terminal/sessions.ts');
  const st = { up: false, tail: '' };
  trackScreen(st, 'hello');
  assert.equal(st.up, false);
  trackScreen(st, 'x\x1b[?10');
  trackScreen(st, '49hdrawing'); // the switch split across two chunks
  assert.equal(st.up, true);
  for (let i = 0; i < 400; i++) trackScreen(st, 'y'.repeat(1024)); // hours of output, far past the 256 KB backlog
  assert.equal(st.up, true);
  trackScreen(st, 'bye\x1b[?1049l');
  assert.equal(st.up, false, 'leaving full screen is seen too');
});
