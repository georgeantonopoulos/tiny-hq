// A click can land in a session that only says "Please run /login · API Error: 403", and nobody
// would hear. Each answer is now watched until the session takes it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACK_MS, ackFrom, addAck, checkAcks, loadAcks } from '../src/team/acks.ts';

const at = Date.parse('2026-11-13T10:15:00Z');
const said = (secs: number, content: unknown[], extra: object = {}) => ({ type: 'assistant', timestamp: new Date(at + secs * 1000).toISOString(), message: { content }, ...extra });

test('a reply or a tool call after the answer is the acknowledgement', () => {
  assert.deepEqual(ackFrom([said(5, [{ type: 'text', text: 'On it: merging #17.' }])], at, at + 10_000), { status: 'ok' });
  assert.deepEqual(ackFrom([said(5, [{ type: 'tool_use', name: 'Bash', input: {} }])], at, at + 10_000), { status: 'ok' });
  // What it said before the answer doesn't count.
  assert.deepEqual(ackFrom([said(-60, [{ type: 'text', text: 'Old reply' }])], at, at + 10_000), { status: 'wait' });
});

test("a sign-in or API error, or silence past the limit, means it wasn't picked up", () => {
  const r = ackFrom([said(1, [{ type: 'text', text: 'Please run /login · API Error: 403 Attention Required! | Cloudflare' }])], at, at + 5_000);
  assert.equal(r.status, 'failed');
  assert.match((r as { why: string }).why, /API Error: 403/);
  assert.equal(ackFrom([said(1, [{ type: 'text', text: 'x' }], { isApiErrorMessage: true })], at, at + 5_000).status, 'failed');
  assert.equal(ackFrom([], at, at + ACK_MS - 1).status, 'wait');
  assert.equal(ackFrom([], at, at + ACK_MS).status, 'failed');
});

test('the office keeps watching until it knows, then reports the misses once', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'acks-')), 'acks.json');
  const base = { cwd: '/Users/owner/Dev/recipe-box', room: 'Recipe Box', answer: 'The owner chose: "Merge #17"', at };
  addAck(path, { ...base, sessionId: '11111111-1111-4111-8111-111111111111', question: 'Merge #17?' });
  addAck(path, { ...base, sessionId: '22222222-2222-4222-8222-222222222222', question: 'Merge #10?' });
  addAck(path, { ...base, sessionId: '33333333-3333-4333-8333-333333333333', question: 'Nothing now?' });
  const transcripts: Record<string, unknown[]> = {
    '11111111-1111-4111-8111-111111111111': [said(2, [{ type: 'text', text: 'Please run /login · API Error: 403' }])],
    '22222222-2222-4222-8222-222222222222': [said(3, [{ type: 'text', text: 'Merged.' }])],
    '33333333-3333-4333-8333-333333333333': [],
  };
  const read = (id: string) => transcripts[id] as never;
  const took: string[] = [];
  const missed = checkAcks(path, at + 10_000, read, (a) => took.push(a.question));
  assert.deepEqual(took, ['Merge #10?'], 'a taken-up answer is reported too');
  assert.deepEqual(missed.map((m) => m.question), ['Merge #17?']);
  assert.deepEqual(loadAcks(path).map((a) => a.question), ['Nothing now?'], 'still waiting on the silent one');
  assert.deepEqual(checkAcks(path, at + ACK_MS + 1, read).map((m) => m.question), ['Nothing now?']);
  assert.deepEqual(loadAcks(path), []);
});
