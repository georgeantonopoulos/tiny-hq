// A click can land in a session that only says "Please run /login · API Error: 403", and nobody
// would hear. Each answer is now watched until the session takes it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACK_MS, ackFrom, ackTold, addAck, checkAcks, loadAcks, transcriptFile } from '../src/team/acks.ts';

const at = Date.parse('2026-11-13T10:15:00Z');
const ANSWER = 'The owner chose: "Merge #17". (They picked it on the button over your head.)';
const said = (secs: number, content: unknown[], extra: object = {}) => ({ type: 'assistant', timestamp: new Date(at + secs * 1000).toISOString(), message: { content }, ...extra });
const typed = (secs: number, text = ANSWER) => ({ type: 'user', timestamp: new Date(at + secs * 1000).toISOString(), message: { content: text } });

test('a reply or a tool call after the answer shows in its chat is the acknowledgement', () => {
  assert.deepEqual(ackFrom([typed(1), said(5, [{ type: 'text', text: 'On it: merging #17.' }])], at, at + 10_000, ANSWER), { status: 'ok' });
  assert.deepEqual(ackFrom([typed(1), said(5, [{ type: 'tool_use', name: 'Bash', input: {} }])], at, at + 10_000, ANSWER), { status: 'ok' });
  // What it said before the answer doesn't count.
  assert.deepEqual(ackFrom([said(-60, [{ type: 'text', text: 'Old reply' }])], at, at + 10_000, ANSWER), { status: 'wait' });
});

test('a busy room: its work on the task before the answer shows is not an acknowledgement', () => {
  const busy = [said(3, [{ type: 'tool_use', name: 'Bash', input: {} }]), said(20, [{ type: 'text', text: 'Tests pass.' }])];
  assert.deepEqual(ackFrom(busy, at, at + 30_000, ANSWER), { status: 'wait' }, 'still on the old task');
  // The answer shows at 60 s, then the session hits a sign-in error: that's caught.
  const r = ackFrom([...busy, typed(60), said(62, [{ type: 'text', text: 'Please run /login · API Error: 403' }])], at, at + 70_000, ANSWER);
  assert.equal(r.status, 'failed');
  // Silence is timed from when the answer showed, not when it was typed.
  assert.equal(ackFrom([...busy, typed(60)], at, at + 60_000 + ACK_MS - 1, ANSWER).status, 'wait');
  assert.equal(ackFrom([...busy, typed(60)], at, at + 60_000 + ACK_MS, ANSWER).status, 'failed');
});

test("a sign-in or API error, or silence past the limit, means it wasn't picked up", () => {
  const r = ackFrom([typed(1), said(1, [{ type: 'text', text: 'Please run /login · API Error: 403 Attention Required! | Cloudflare' }])], at, at + 5_000, ANSWER);
  assert.equal(r.status, 'failed');
  assert.match((r as { why: string }).why, /API Error: 403/);
  assert.equal(ackFrom([typed(1), said(1, [{ type: 'text', text: 'x' }], { isApiErrorMessage: true })], at, at + 5_000, ANSWER).status, 'failed');
  assert.equal(ackFrom([typed(0)], at, at + ACK_MS - 1, ANSWER).status, 'wait');
  assert.equal(ackFrom([typed(0)], at, at + ACK_MS, ANSWER).status, 'failed');
  assert.equal(ackFrom([], at, at + 30 * 60_000, ANSWER).status, 'failed', 'never showed in its chat');
});

test('a miss is kept and reported on every check until the manager has been told', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'acks-')), 'acks.json');
  const base = { cwd: '/Users/owner/Dev/recipe-box', room: 'Recipe Box', answer: ANSWER, at };
  addAck(path, { ...base, sessionId: '11111111-1111-4111-8111-111111111111', question: 'Merge #17?' });
  addAck(path, { ...base, sessionId: '22222222-2222-4222-8222-222222222222', question: 'Merge #10?' });
  addAck(path, { ...base, sessionId: '33333333-3333-4333-8333-333333333333', question: 'Nothing now?' });
  const transcripts: Record<string, unknown[]> = {
    '11111111-1111-4111-8111-111111111111': [typed(1), said(2, [{ type: 'text', text: 'Please run /login · API Error: 403' }])],
    '22222222-2222-4222-8222-222222222222': [typed(1), said(3, [{ type: 'text', text: 'Merged.' }])],
    '33333333-3333-4333-8333-333333333333': [typed(1)],
  };
  const read = (id: string) => transcripts[id] as never;
  const missed = checkAcks(path, at + 10_000, read);
  assert.deepEqual(missed.map((m) => m.question), ['Merge #17?']);
  // The manager was busy: the miss comes back next time.
  assert.deepEqual(checkAcks(path, at + 30_000, read).map((m) => m.question), ['Merge #17?']);
  ackTold(path, missed[0]!);
  assert.deepEqual(loadAcks(path).map((a) => a.question), ['Nothing now?'], 'still waiting on the silent one');
  assert.deepEqual(checkAcks(path, at + 1_000 + ACK_MS + 1, read).map((m) => m.question), ['Nothing now?']);
});

test('once the answer has shown, a later read that no longer reaches back to it still counts the reply', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'acks-')), 'acks.json');
  const id = '44444444-4444-4444-8444-444444444444';
  addAck(path, { cwd: '/Users/owner/Dev/recipe-box', room: 'Recipe Box', answer: ANSWER, at, sessionId: id, question: 'Merge #17?' });
  let recs: unknown[] = [typed(2), said(3, [{ type: 'tool_use', name: 'Bash', input: {} }], { isSidechain: true })];
  const read = () => recs as never;
  assert.deepEqual(checkAcks(path, at + 10_000, read), []);
  assert.equal(loadAcks(path)[0]!.shownAt, at + 2_000, 'when it showed is kept');
  // A big tool result pushed the answer out of the transcript read; the reply after it still counts.
  recs = [said(40, [{ type: 'text', text: 'Merged #17.' }])];
  assert.deepEqual(checkAcks(path, at + 50_000, read), []);
  assert.deepEqual(loadAcks(path), [], 'taken up');
  assert.equal(ackFrom([], at, at + 2_000 + ACK_MS, ANSWER, at + 2_000).status, 'failed', 'silence still counts from when it showed');
});

test('answering the same question again never drops a miss the manager has not heard about', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'acks-')), 'acks.json');
  const base = { cwd: '/Users/owner/Dev/recipe-box', room: 'Recipe Box', answer: ANSWER, sessionId: '55555555-5555-4555-8555-555555555555', question: 'Merge #17?' };
  addAck(path, { ...base, at });
  checkAcks(path, at + 10_000, () => [typed(1), said(2, [{ type: 'text', text: 'Please run /login · API Error: 403' }])] as never);
  addAck(path, { ...base, at: at + 60_000 });
  assert.deepEqual(loadAcks(path).map((a) => [a.at, !!a.why]), [[at, true], [at + 60_000, false]]);
});

test('an answer handed to a busy session as a queued command counts as shown', () => {
  const queued = { type: 'attachment', timestamp: new Date(at + 8_000).toISOString(), attachment: { type: 'queued_command', prompt: ANSWER } };
  const recs = [typed(0, 'The owner chose: "Merge #16". (They picked it…)'), queued, said(20, [{ type: 'tool_use', name: 'Bash', input: {} }])];
  assert.deepEqual(ackFrom(recs as never, at, at + 40 * 60_000, ANSWER), { status: 'ok' });
});

test('a session that moved into a worktree after the answer is still found, and an answer scrolled out of the tail counts as taken up', () => {
  // Claude Code moves the transcript to the worktree's folder; the newest copy wins.
  const home = mkdtempSync(join(tmpdir(), 'acks-home-'));
  const id = 'f4f9b347-1cc5-4c39-82cb-26d7733ee144';
  const main = join(home, '.claude', 'projects', '-r-atlas');
  const wt = join(home, '.claude', 'projects', '-r-atlas--claude-worktrees-x');
  mkdirSync(main, { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(main, `${id}.jsonl`), '');
  writeFileSync(join(wt, `${id}.jsonl`), '');
  utimesSync(join(main, `${id}.jsonl`), new Date(at), new Date(at));
  assert.equal(transcriptFile(id, '/r/atlas', home), join(wt, `${id}.jsonl`));
  assert.equal(transcriptFile('00000000-0000-0000-0000-000000000000', '/r/atlas', home), undefined);
  // By the time the watch read it again, the answer was older than the tail it reads.
  const clipped = (recs: object[]) => Object.assign(recs, { clipped: true }) as Parameters<typeof ackFrom>[0];
  assert.deepEqual(ackFrom(clipped([said(600, [{ type: 'text', text: 'Shipped.' }])]), at, at + 31 * 60_000, ANSWER), { status: 'ok' });
  // The whole transcript was read and the answer isn't in it: not taken up.
  assert.equal(ackFrom([said(600, [{ type: 'text', text: 'Shipped.' }])], at, at + 31 * 60_000, ANSWER).status, 'failed');
  // Only API errors since: still not taken up.
  assert.equal(ackFrom(clipped([said(600, [{ type: 'text', text: 'API Error' }], { isApiErrorMessage: true })]), at, at + 31 * 60_000, ANSWER).status, 'failed');
});
