import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Allowance, meters, parseUsage } from '../src/team/budget.ts';
import { createDaemon } from '../src/daemon/server.ts';
import { heard, recognitionClass, resetText } from '../web/app/topbar.ts';

const now = Date.parse('2026-11-10T04:10:00Z');
const meter = (provider: string, five: number, week: number) =>
  JSON.stringify([{ provider, usage: { primary: { windowMinutes: 300, usedPercent: five, resetsAt: '2026-11-10T07:00:38Z' }, secondary: { windowMinutes: 10080, usedPercent: week, resetsAt: '2026-11-11T07:01:23Z' } } }]);

test('the usage board has Claude and Codex, each with its 5-hour and weekly window and resets', async () => {
  assert.equal(parseUsage(meter('codex', 2, 37), now, 'codex')!.weekly!.usedPercent, 37);
  assert.equal(parseUsage(meter('codex', 2, 37), now, 'claude'), undefined, "Codex's row is never read as Claude's");
  const a = new Allowance(async (p) => (p === 'claude' ? meter('claude', 10, 62) : meter('codex', 2, 37)), () => now);
  await a.refresh();
  const m = meters(a, now);
  assert.deepEqual(
    m.map((x) => [x.provider, x.fiveHour?.used, x.week?.used, x.stale]),
    [
      ['claude', 10, 62, false],
      ['codex', 2, 37, false],
    ],
  );
  assert.equal(m[0]!.week!.resetsAt, Date.parse('2026-11-11T07:01:23Z'));
  // One provider failing doesn't hide the other.
  const b = new Allowance(async (p) => (p === 'codex' ? Promise.reject(new Error('down')) : meter('claude', 10, 62)), () => now);
  await b.refresh();
  assert.deepEqual(meters(b, now).map((x) => x.provider), ['claude']);
  // Old readings are marked stale, and a window that has reset reads 0%.
  assert.equal(meters(a, now + 31 * 60_000)[0]!.stale, true);
  assert.equal(meters(a, Date.parse('2026-11-10T08:00:00Z'))[0]!.fiveHour!.used, 0);
});

test('reset times read plainly', () => {
  assert.equal(resetText(now + 25 * 60_000, now), 'resets in 25m');
  assert.equal(resetText(now + 170 * 60_000, now), 'resets in 2h 50m');
  assert.match(resetText(Date.parse('2026-11-11T07:01:23Z'), now), /^resets Wed \d\d:\d\d$/);
  assert.equal(resetText(undefined, now), '');
});

test("the mic: the browser's words go to the manager, empty or oversized ones are refused", async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const got: string[] = [];
  const d = createDaemon({ token: 't', port, say: async (text) => void got.push(text), usage: async () => ({ meters: [] }) });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  const call = (path: string, method = 'GET', body?: string, token = 't') =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  try {
    assert.equal(await call('/api/say', 'POST', '{"text":"hello Manager"}', 'wrong'), 401);
    assert.equal(await call('/api/say', 'POST', '{"text":"hello Manager"}'), 200);
    assert.equal(await call('/api/say', 'POST', '{"text":"   "}'), 400);
    assert.equal(await call('/api/say', 'POST', JSON.stringify({ text: 'x'.repeat(4001) })), 400);
    assert.equal(await call('/api/say', 'POST', 'not json'), 400);
    assert.deepEqual(got, ['hello Manager']);
    assert.equal(await call('/api/usage'), 200);
  } finally {
    d.close();
  }
});

test("speech recognition: the words heard so far, and browsers that can't do it", () => {
  const r = (t: string, isFinal = true) => Object.assign([{ transcript: t }], { isFinal });
  assert.equal(heard([r('Hello Manager,'), r(' merge   Val’s fix', false)]), 'Hello Manager, merge Val’s fix');
  assert.equal(heard([]), '');
  // Chrome on Android repeats what came before in each new result: no doubled words.
  assert.equal(heard([r('hello'), r('hello Manager'), r('hello Manager merge it')]), 'hello Manager merge it');
  class Rec {}
  assert.equal(recognitionClass({ webkitSpeechRecognition: Rec }), Rec);
  assert.equal(recognitionClass({}), undefined);
});
