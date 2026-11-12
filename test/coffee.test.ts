import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBreak, applyTidy, breakDue, FADE_MS, prune, removeTip, tidyDue, type Tip, chatsDir, coffeePrompt, grounded, loadCoffee, nextGap, parseCoffee, pickRooms, recentNotes, renderBoard, saveCoffee } from '../src/team/coffee.ts';

// The coffee room is where rooms meet and share what they learned; how often and who follows
// usage, with some chance. One cheap Sonnet writer, from each room's recent chats.
test('how often: by allowance, with chance in it, waking hours only', () => {
  assert.equal(nextGap(92, 10), undefined, 'week nearly used: no breaks');
  assert.equal(nextGap(30, 85), undefined, '5-hour window nearly used: no breaks');
  assert.equal(nextGap(undefined, undefined), undefined, "allowance not read: wait");
  const spare = nextGap(20, 10, () => 0.5)!;
  const tight = nextGap(80, 10, () => 0.5)!;
  assert.ok(spare < tight, 'more often when there is plenty to spare');
  assert.notEqual(nextGap(20, 10, () => 0), nextGap(20, 10, () => 1), 'chance moves it');
  const at = (h: number) => new Date(2026, 10, 11, h, 0);
  assert.equal(breakDue({ tips: [], removed: [] }, at(7)), false);
  assert.equal(breakDue({ tips: [], removed: [] }, at(11)), true);
  assert.equal(breakDue({ tips: [], removed: [], next: at(12).getTime() }, at(11)), false);
});

test('who: 2 or 3 rooms, busier ones likelier, everyone has a chance', () => {
  const rooms = [{ name: 'Lumen', activity: 1 }, { name: 'Juniper', activity: 0 }, { name: 'Lamp', activity: 0.4 }, { name: 'Obsidian', activity: 0.7 }];
  let seq = 0;
  const r = () => [0.1, 0.0, 0.99, 0.5][seq++ % 4]!;
  const two = pickRooms(rooms, r);
  assert.equal(two.length, 2);
  assert.equal(new Set(two.map((x) => x.name)).size, 2, 'never the same room twice');
  const counts: Record<string, number> = {};
  let s = 1;
  const lcg = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) for (const x of pickRooms(rooms, lcg)) counts[x.name] = (counts[x.name] ?? 0) + 1;
  assert.ok(counts.Lumen! > counts.Juniper!, 'busier rooms go more often');
  assert.ok(counts.Juniper! > 0, 'a quiet room still gets a coffee');
});

test("the writer reads each room's newest chats and the board lists what it shared", () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const chats = chatsDir('/Users/g/Dev/Watch Face', home);
  assert.equal(chats, join(home, '.claude', 'projects', '-Users-g-Dev-Watch-Face'));
  mkdirSync(chats, { recursive: true });
  const said = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  writeFileSync(join(chats, 'a.jsonl'), [JSON.stringify({ type: 'user', message: { content: 'go' } }), said('Owner wants every release note in plain words.'), said('(quiet)')].join('\n') + '\n');
  assert.match(recentNotes('/Users/g/Dev/Watch Face', 6, 1200, home)[0]!, /plain words/);
  assert.deepEqual(recentNotes('/Users/g/Dev/Nothing', 6, 1200, home), []);
  assert.match(coffeePrompt([{ name: 'Watch Face', notes: ['x'] }], []), /JSON only/);

  const out = JSON.stringify({ result: JSON.stringify({ chat: [{ room: 'Watch Face', line: 'Plain words win.' }, { room: 'Nobody', line: 'x' }], tips: [{ room: 'Watch Face', kind: 'owner', text: 'The owner wants release notes in plain words.' }, { room: 'Watch Face', kind: 'tip', text: 'Use token abc' }, { room: 'Watch Face', kind: 'nonsense', text: 'x' }] }) });
  // A tip must quote the words it rests on, found in that room's notes.
  const notes = ['The owner wants every release note in plain words, they said last week.'];
  const quoted = JSON.stringify({ chat: [{ room: 'Watch Face', line: 'Hi.' }], tips: [
    { room: 'Watch Face', kind: 'owner', text: 'Release notes in plain words.', evidence: 'The owner wants every release note in plain words' },
    { room: 'Watch Face', kind: 'owner', text: 'The owner always squashes merges.', evidence: 'The owner always squashes every merge' },
    { room: 'Watch Face', kind: 'tip', text: 'No quote.' },
  ] });
  assert.deepEqual(parseCoffee(quoted, ['Watch Face'], () => notes)!.tips.map((t) => t.text), ['Release notes in plain words.'], 'unsupported or unquoted tips are dropped');
  assert.equal(grounded('plain words', notes), false, 'a quote of a few words proves nothing');
  const r = parseCoffee(out, ['Watch Face'])!;
  assert.deepEqual(r.chat.map((c) => c.room), ['Watch Face'], 'only rooms that were there');
  assert.deepEqual(r.tips.map((t) => t.text), ['The owner wants release notes in plain words.'], 'no secrets, no unknown kinds');
  assert.equal(parseCoffee('not json', ['Watch Face']), undefined);

  const one = applyBreak({ tips: [], removed: [] }, { chat: [], tips: [{ room: 'Watch Face', kind: 'owner', text: r.tips[0]!.text }], same: [] }, 1);
  const tips = one.tips;
  assert.match(renderBoard(tips), /## How the owner likes to work\n\n- The owner wants release notes in plain words\. \(Watch Face/);

  const data = mkdtempSync(join(tmpdir(), 'cm-'));
  saveCoffee(data, { tips, next: 5, removed: [] });
  assert.equal(loadCoffee(data).next, 5);
  assert.match(readFileSync(join(data, 'coffee', 'board.md'), 'utf8'), /plain words/);
});

test('every room is told to read the board', () => {
  assert.match(readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8'), /coffee\/board\.md/);
});

// The board's upkeep: confirm instead of copy, weekly tidy, 30-day fade, their ×.
const tip = (id: string, kind: Tip['kind'], text: string, extra: Partial<Tip> = {}): Tip => ({ id, kind, text, from: 'Lamp', at: 1, seen: 1, last: 1, ...extra });

test('a repeat confirms the tip instead of copying it; a removed tip never comes back', () => {
  const s0 = { tips: [tip('a1', 'mac', 'The Claude app shell has no local network access.')], removed: ['Old wrong tip.'] };
  const s1 = applyBreak(s0, { chat: [], tips: [{ room: 'Lumen', kind: 'mac', text: 'the claude app shell has NO local network access' }, { room: 'Lumen', kind: 'bug', text: 'Old wrong tip' }], same: [{ room: 'Juniper', id: 'a1' }] }, 100);
  assert.equal(s1.tips.length, 1, 'no copy, and the removed tip stays out');
  assert.equal(s1.tips[0]!.seen, 3, 'confirmed by Juniper (same id) and Lumen (same words)');
  assert.equal(s1.tips[0]!.last, 100);
  assert.equal(s1.tips[0]!.from, 'Lamp, Juniper, Lumen');
  const prompt = coffeePrompt([{ name: 'Lumen', notes: ['x'] }], s0.tips, s0.removed);
  assert.match(prompt, /a1: The Claude app shell/);
  assert.match(prompt, /The owner removed these: \["Old wrong tip\."\]/);
  const same = JSON.stringify({ chat: [{ room: 'Lumen', line: 'Hi.' }], tips: [{ room: 'Lumen', same: 'a1', evidence: 'the shell has no local network access at all' }, { room: 'Lumen', same: 'zz', evidence: 'the shell has no local network access at all' }] });
  assert.deepEqual(parseCoffee(same, ['Lumen'], () => ['so the shell has no local network access at all here'], ['a1'])!.same, [{ room: 'Lumen', id: 'a1' }], 'only real board ids, with a quote');
  const gone = removeTip(s1, 'a1')!;
  assert.equal(gone.tips.length, 0);
  assert.deepEqual(gone.removed.slice(-1), ['The Claude app shell has no local network access.']);
  assert.equal(removeTip(gone, 'a1'), undefined);
});

test('the board stays short: 30-day fade (not tips about the owner), 10 per section, 40 in all', () => {
  const now = 100 * FADE_MS;
  const old = now - FADE_MS - 1;
  const kept = prune([tip('g', 'owner', 'They review by screenshots.', { last: old }), tip('t', 'tip', 'Old tip.', { last: old }), tip('n', 'tip', 'New tip.', { last: now })], now);
  assert.deepEqual(kept.map((t) => t.id), ['g', 'n'], 'an unconfirmed tip fades; one about the owner stays');
  const many = Array.from({ length: 15 }, (_, i) => tip(`b${i}`, 'bug', `Bug ${i}.`, { seen: i, last: now }));
  const bugs = prune(many, now);
  assert.equal(bugs.length, 10);
  assert.ok(bugs.every((t) => t.seen >= 5), 'the most confirmed stay');
  const all = (['owner', 'tip', 'bug', 'mac'] as const).flatMap((k) => Array.from({ length: 12 }, (_, i) => tip(`${k}${i}`, k, `${k} ${i}.`, { last: now })));
  assert.equal(prune(all, now).length, 40);
});

test('the weekly tidy merges rewordings and drops stale tips, but never throws most of the board away', () => {
  const s = { tips: [tip('a', 'mac', 'No LAN from the Claude app shell.', { seen: 2 }), tip('b', 'mac', 'The Claude app shell cannot reach the local network.', { from: 'Lumen', seen: 1, last: 9 }), tip('c', 'bug', 'The office loses the manager buttons on chat.'), tip('d', 'tip', 'Use launchd for LAN sends.')], removed: [] };
  assert.equal(tidyDue(s, 10), false, 'too few tips to bother');
  const out = JSON.stringify({ result: JSON.stringify({ tips: [{ ids: ['a', 'b'], kind: 'mac', text: 'The Claude app shell has no local network access.' }], dropped: [{ id: 'c', why: 'fixed on 11 Nov' }] }) });
  const r = applyTidy(s, out, 50)!;
  const merged = r.state.tips.find((t) => t.id === 'a')!;
  assert.equal(merged.seen, 3);
  assert.equal(merged.from, 'Lamp, Lumen');
  assert.equal(merged.last, 9);
  assert.ok(!r.state.tips.some((t) => t.id === 'b' || t.id === 'c'), 'merged and dropped tips are gone');
  assert.ok(r.state.tips.some((t) => t.id === 'd'), 'a tip the tidy forgot is kept, never silently lost');
  assert.equal(r.state.tidiedAt, 50);
  const big = { tips: Array.from({ length: 12 }, (_, i) => tip(`x${i}`, 'tip', `Tip ${i}.`)), removed: [] };
  assert.equal(applyTidy(big, JSON.stringify({ tips: [{ ids: ['x0'], kind: 'tip', text: 'Tip 0.' }], dropped: big.tips.slice(1).map((t) => ({ id: t.id, why: 'x' })) }), 50), undefined, 'a tidy keeping under a third is not trusted');
  assert.equal(applyTidy(s, 'nonsense', 50), undefined);
});
