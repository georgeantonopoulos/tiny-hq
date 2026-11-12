// Without this, the manager hands the owner work that isn't theirs. Every button for the owner
// says why only they can do it and what was tried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOnlyOwner, REASONS, takeOnlyOwner } from '../src/team/only-owner.ts';
import { leftovers, LEFTOVER_QUIET_MS } from '../src/terminal/status.ts';
import { validAsk } from '../src/team/asks.ts';

test('only the owner: a reason from the short list and a real attempt, nothing else', () => {
  assert.deepEqual(Object.keys(REASONS).sort(), ['choice', 'password', 'pay', 'permission', 'post', 'send']);
  assert.equal(checkOnlyOwner('send', 'Drafted it, subject "Testers"'), undefined);
  assert.equal(checkOnlyOwner('PASSWORD', 'Opened pypi.org in their Chrome: signed out, password box'), undefined);
  assert.match(checkOnlyOwner(undefined, 'tried lots of things')!, /Missing --why/);
  assert.match(checkOnlyOwner('login', 'tried lots of things')!, /not something only the owner can do/);
  assert.match(checkOnlyOwner('reconnect', 'x')!, /office fault/);
  assert.match(checkOnlyOwner('choice', '')!, /Missing --tried/);
  assert.match(checkOnlyOwner('choice', '  nothing ')!, /Missing --tried/);
  assert.deepEqual(takeOnlyOwner(['q', '--why', 'pay', 'more', '--tried', 'checked the price']), { rest: ['q', 'more'], why: 'pay', tried: 'checked the price' });
  assert.equal(validAsk({ id: 'abcdef12', folder: '/x', question: 'Pay?', why: 'pay', tried: 'checked\nthe price' })!.tried, 'checked the price');
});

function run(cli: 'ask' | 'job', dir: string, ...a: string[]) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', new URL(`../src/cli/${cli}.ts`, import.meta.url).pathname, ...a], {
    cwd: dir,
    env: { ...process.env, CM_DATA_DIR: dir, CLAUDE_CODE_SESSION_ID: '11111111-2222-4333-8444-555555555555' },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
const asks = (dir: string) => JSON.parse(readFileSync(join(dir, 'manager', 'asks.json'), 'utf8')).asks as { question: string; why?: string; tried?: string; job?: string }[];

test('manager/ask refuses a button without --why and --tried, and keeps what was tried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-only-'));
  mkdirSync(join(dir, 'manager'));
  const bare = run('ask', dir, 'Please reconnect the email connector?');
  assert.equal(bare.code, 2);
  assert.match(bare.out, /No button for the owner[\s\S]*Missing --why/);
  assert.equal(run('ask', dir, 'Please reconnect the email connector?', '--why', 'login', '--tried', 'asked the owner already').code, 2);
  assert.equal(run('ask', dir, 'Post this on X?', '--why', 'post', '--tried', 'Wrote the text and checked X rules').code, 2, 'a post needs its exact text (--text)');
  const ok = run('ask', dir, 'Post this on X? (text in post.md)', '--why', 'post', '--tried', 'Wrote the text and checked X rules', '--text', 'Hello X');
  assert.equal(ok.code, 2, 'a post needs where it goes (--target)');
  const ok2 = run('ask', dir, 'Post this on X? (text in post.md)', '--why', 'post', '--tried', 'Wrote the text and checked X rules', '--text', 'Hello X', '--target', 'https://x.com/compose');
  assert.equal(ok2.code, 0, ok2.out);
  assert.deepEqual(asks(dir).map((a) => [a.question, a.why, a.tried, (a as { target?: string }).target]), [['Post this on X? (text in post.md)', 'post', 'Wrote the text and checked X rules', 'https://x.com/compose']]);
});

test('job wait refuses without proof and leaves the job active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-only-'));
  mkdirSync(join(dir, 'manager'));
  const file = join(dir, 'manager', 'jobs.json');
  writeFileSync(file, JSON.stringify({ jobs: [{ id: 'pypi', room: dir, title: 'Harbor on PyPI', done: 'pip install works', status: 'active', createdAt: 1, updatedAt: 1 }] }));
  const bare = run('job', dir, 'wait', 'pypi', 'Sign in to PyPI');
  assert.equal(bare.code, 2);
  assert.match(bare.out, /stays active/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].status, 'active');
  const ok = run('job', dir, 'wait', 'pypi', 'Type your PyPI password', '--why', 'password', '--tried', 'Opened pypi.org in Chrome: signed out, password box');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].status, 'waiting');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].waitingFor, 'Type your PyPI password');
  assert.equal(asks(dir)[0]!.tried, 'Opened pypi.org in Chrome: signed out, password box');
});

test('left-over sessions are the office\'s to close, never the owner\'s', () => {
  const now = 10 * LEFTOVER_QUIET_MS;
  const ids = leftovers(
    [
      { id: 'gone0000', state: 'blocked', alive: false, room: 'Lumen', lastActive: now - 1000 }, // process gone: close
      { id: 'noroom00', state: 'done', claudeState: 'blocked', alive: true, lastActive: now - LEFTOVER_QUIET_MS }, // in no room, quiet: close
      { id: 'fresh000', state: 'blocked', alive: true, lastActive: now - 60_000 }, // in no room but just active: keep
      { id: 'inroom00', state: 'blocked', alive: true, room: 'Lumen', lastActive: 0 }, // a room shows it: keep
      { id: 'owner000', kind: 'interactive', state: 'blocked', alive: false, lastActive: 0 }, // the owner's own: never
      { id: 'idle0000', state: 'done', alive: false, lastActive: 0 }, // not blocked: not a left-over
    ],
    now,
  ).map((s) => s.id);
  assert.deepEqual(ids, ['gone0000', 'noroom00']);
});

test("The manager's rules: try first, the owner last, and no more 'The owner can close it'", () => {
  const g = readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8');
  assert.match(g, /## Try first: the owner comes last/);
  assert.match(g, /Office faults[^\n]*tiny-hq doctor/);
  assert.match(g, /--why <send\|post\|pay\|choice\|permission\|password>/);
  assert.match(g, /Try before you ask/);
  assert.doesNotMatch(g, /sessions the owner can close/);
  assert.doesNotMatch(g, /or a login\/2-factor prompt\./);
  const skill = readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Try first; the owner comes last/);
  assert.match(skill, /A sign-in is yours when the owner's browser is already signed in/);
});
