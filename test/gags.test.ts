import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGags, DAY, gagPrompt, gagsDue, KEEP, loadGags, parseGags, RETRY, saveGags } from '../src/office/gags.ts';
import { ANIMS, HAPPENINGS, nextHappening, PROPS, validGag } from '../web/app/whimsy.ts';

test("Haiku's gags: only short plain lines that use the office's own props and moves", () => {
  assert.deepEqual(validGag({ text: "{name}'s rubber duck started a code review.", who: 'anyone', prop: 'duck', anim: 'hop' }), { text: "{name}'s rubber duck started a code review.", who: 'anyone', prop: 'duck', anim: 'hop' });
  assert.ok(validGag({ text: 'The Manager hummed at the stapler. It hummed back.', who: 'manager', anim: 'notes' }));
  const bad = [
    { text: 'A cat walked in.', who: 'anyone' }, // no {name}/{room}
    { text: '{name} found a {thing} under the desk.', who: 'anyone' }, // a brace the office can't fill
    { text: '{name} visited https://example.com today.', who: 'anyone' },
    { text: '{name} drew <script> on the whiteboard.', who: 'anyone' },
    { text: '{name} asked the boss for a raise.', who: 'anyone' }, // never "boss"
    { text: '{name} juggled three staplers at once.', who: 'anyone', prop: 'piano' }, // not in the kit
    { text: '{name} juggled three staplers at once.', who: 'anyone', anim: 'explode' },
    { text: 'The manager slept at their desk.', who: 'manager' },
    { text: `{name} ${'very '.repeat(40)}long`, who: 'anyone' },
  ];
  for (const b of bad) assert.equal(validGag(b), undefined, JSON.stringify(b));
});

test("the writer's answer: JSON envelope or plain text, junk dropped", () => {
  const arr = [{ text: '{name} adopted a cactus named Gerald.', who: 'anyone', prop: 'cactus' }, { text: 'nope', who: 'anyone' }];
  assert.equal(parseGags(JSON.stringify({ result: `Here you go:\n${JSON.stringify(arr)}` })).length, 1);
  assert.equal(parseGags(JSON.stringify(arr)).length, 1);
  assert.deepEqual(parseGags(JSON.stringify({ is_error: true, result: '[]' })), []);
  assert.deepEqual(parseGags('sorry, no'), []);
  const prompt = gagPrompt({ at: 0, ok: true, gags: [] }, () => 0.5);
  for (const k of [...PROPS, ...ANIMS]) assert.ok(prompt.includes(k), k);
});

test('a new batch a day (six hours after a failed try); repeats skipped; the pool stays small', () => {
  const now = 10 * DAY;
  assert.ok(gagsDue({ at: 0, ok: true, gags: [] }, now));
  assert.ok(!gagsDue({ at: now - DAY + 1, ok: true, gags: [] }, now));
  assert.ok(!gagsDue({ at: now - RETRY + 1, ok: false, gags: [] }, now));
  assert.ok(gagsDue({ at: now - RETRY, ok: false, gags: [] }, now));
  const g = (i: number) => ({ text: `{name} gag number ${i} happened.`, who: 'anyone' as const });
  let f = addGags({ at: 0, ok: false, gags: [] }, [g(1), g(1), { text: HAPPENINGS[0]!, who: 'anyone' }], now);
  assert.equal(f.gags.length, 1, 'a repeat and a built-in line are skipped');
  assert.ok(f.ok && f.at === now);
  f = addGags(f, Array.from({ length: KEEP + 5 }, (_, i) => g(i + 2)), now);
  assert.equal(f.gags.length, KEEP);
  assert.equal(f.gags[0]!.text, g(2).text, 'newest first');
  const dir = mkdtempSync(join(tmpdir(), 'cm-gags-'));
  saveGags(join(dir, 'h.json'), f);
  assert.deepEqual(loadGags(join(dir, 'h.json')), f);
  assert.deepEqual(loadGags(join(dir, 'missing.json')), { at: 0, ok: true, gags: [] });
});

test('a written gag shows with its prop and move; manager lines only over the manager, by their own name', () => {
  const cast = [{ id: 'manager', first: 'Mo', room: 'Manager' }, { id: 'lead:x', first: 'Rex', room: 'Lumen' }];
  const gags = [
    { text: '{name} brought cake for {room}.', who: 'anyone' as const, prop: 'cake' as const, anim: 'confetti' as const },
    { text: 'The Manager took a nap.', who: 'manager' as const, anim: 'zzz' as const },
  ];
  assert.deepEqual(nextHappening(cast, (id) => id === 'lead:x', () => 0, gags), { id: 'lead:x', text: 'Rex brought cake for Lumen.', prop: 'cake', anim: 'confetti' });
  assert.deepEqual(nextHappening(cast, (id) => id === 'manager', () => 0, gags), { id: 'manager', text: 'Mo took a nap.', anim: 'zzz' }, 'manager lines use the name the owner gave the manager');
  // Without written gags, the built-in lines as before.
  const built = HAPPENINGS.map((l) => l.replaceAll('{name}', 'Rex').replaceAll('{room}', 'Lumen'));
  assert.ok(built.includes(nextHappening(cast, (id) => id === 'lead:x', () => 0)!.text));
});
