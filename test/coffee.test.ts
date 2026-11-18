import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPosts, FADE_MS, loadCoffee, minRooms, prune, queuePost, removeTip, renderBoard, saveCoffee, POSTS_PER_DAY, startupNote, STARTUP_MAX, takePosts, type Post, type Tip, withoutRooms } from '../src/team/coffee.ts';

const tip = (id: string, kind: Tip['kind'], text: string, extra: Partial<Tip> = {}): Tip => ({ id, kind, text, from: 'Lamp', at: 1, seen: 1, last: 1, ...extra });
const ROOMS: Record<string, { id: string; name: string }> = { '/d/lamp': { id: 'lead:l', name: 'Lamp' }, '/d/lumen': { id: 'lead:m', name: 'Lumen' } };
const room = (f: string) => ROOMS[f];
const add = (folder: string, kind: Tip['kind'], text: string, at = 1): Post => ({ folder, at, kind, text });
const BIG = { tips: [] as Tip[], removed: [] as string[], rooms: 4 }; // an office of 3+ rooms: tips need a second room

// No model, no tokens: rooms post tips themselves, the office files them with plain code.
test('a post goes on as a waiting tip; a second room confirming it puts it on the board', () => {
  const r1 = applyPosts(BIG, [add('/d/lamp', 'mac', 'The Claude app shell has no local network access.')], room, 10);
  assert.equal(r1.state.tips.length, 1);
  assert.deepEqual(r1.said, [{ id: 'lead:l', name: 'Lamp', line: 'The Claude app shell has no local network access.' }]);
  assert.equal(r1.state.last!.at, 10, 'the poster walks to the coffee room on the floor');
  assert.doesNotMatch(renderBoard(r1.state.tips, 2), /local network/, 'one room only: it waits off the board');
  assert.match(renderBoard(r1.state.tips, 2), /no tip has come up in two rooms/);

  const id = r1.state.tips[0]!.id;
  const r2 = applyPosts(r1.state, [{ folder: '/d/lumen', at: 20, same: id }], room, 20);
  assert.equal(r2.state.tips[0]!.from, 'Lamp, Lumen');
  assert.equal(r2.state.tips[0]!.seen, 2);
  assert.match(renderBoard(r2.state.tips, 2), /## The Mac and its tools\n\n- The Claude app shell has no local network access\. \(Lamp, Lumen; confirmed 2 times/);
  assert.match(r2.said[0]!.line, /^Same here: /);
});

test('in an office of one or two rooms every tip shows at once', () => {
  assert.equal(minRooms(2), 1);
  assert.equal(minRooms(3), 2);
  const r = applyPosts({ tips: [], removed: [], rooms: 2 }, [add('/d/lamp', 'owner', 'The owner wants screenshots before any merge.')], room, 10);
  assert.match(renderBoard(r.state.tips, minRooms(2)), /screenshots before any merge/);
  assert.match(startupNote(r.state.tips, minRooms(2)), /On the board:\n- \[\w+\] The owner wants screenshots/);
});

test('the same words from another room confirm instead of copying; a room never confirms its own tip', () => {
  const s0 = { tips: [tip('a1', 'mac', 'The Claude app shell has no local network access.')], removed: ['Old wrong tip.'] };
  const r = applyPosts(s0, [
    add('/d/lamp', 'mac', 'the claude app shell has NO local network access'),
    { folder: '/d/lamp', at: 1, same: 'a1' },
    add('/d/lumen', 'bug', 'Old wrong tip'),
    add('/d/lumen', 'tip', 'Use token abc to sign in'),
    add('/d/lumen', 'tip', 'See https://example.com for the fix'),
    add('/d/nowhere', 'tip', 'A folder that is no room on the floor'),
    { folder: '/d/lumen', at: 1, kind: 'nonsense' as Tip['kind'], text: 'Unknown kind of tip here' },
  ], room, 100);
  assert.equal(r.state.tips.length, 1, 'no copy, no removed tip, no secrets, no strangers, no unknown kinds');
  assert.equal(r.state.tips[0]!.seen, 1, "Lamp's own repeats don't count");
  assert.deepEqual(r.said, []);
  assert.equal(r.state.last, undefined, 'nobody said anything: nobody walks to coffee');
  const r2 = applyPosts(s0, [add('/d/lumen', 'mac', 'The Claude app shell has no local network access!')], room, 100);
  assert.equal(r2.state.tips[0]!.from, 'Lamp, Lumen');
});

test("posts queue in a file the office empties; a post written while it's taking is kept", () => {
  const data = mkdtempSync(join(tmpdir(), 'th-'));
  assert.deepEqual(takePosts(data), []);
  queuePost(data, add('/d/lamp', 'tip', 'One.'));
  queuePost(data, { folder: '/d/lumen', at: 2, same: 'x' });
  assert.equal(takePosts(data).length, 2);
  assert.deepEqual(takePosts(data), [], 'taken once');
  queuePost(data, add('/d/lamp', 'tip', 'Two.'));
  assert.equal(takePosts(data).length, 1);
});

test('every room session starts with the board and the waiting tips, short, with ids and how to post', () => {
  const tips = [tip('on1', 'tip', 'Merge only on their button.', { from: 'Lamp, Lumen', at: 5 }), tip('w1', 'mac', 'Peekaboo needs Screen Recording.', { at: 9 })];
  const note = startupNote(tips, 2);
  assert.match(note, /On the board \(two or more rooms\):\n- \[on1\] Merge only on their button\./);
  assert.match(note, /Waiting for a second room[^\n]*\n- \[w1\] Peekaboo/);
  assert.match(note, /manager\/coffee add/);
  assert.match(note, /manager\/coffee same <id>/);
  const many = Array.from({ length: 80 }, (_, i) => tip(`x${i}`, 'tip', `A fairly long tip number ${i} about something rooms keep running into on this Mac.`, { at: i }));
  const long = startupNote(many, 2);
  assert.ok(long.length <= STARTUP_MAX, `${long.length} chars`);
  assert.match(long, /\[x79\]/, 'newest waiting tips first');
  assert.match(long, /manager\/coffee add/, 'the how-to line is never cut off');
  assert.match(startupNote([]), /No tips yet/);
  // The hook cuts by bytes, so the cap counts bytes (Greek takes two per letter).
  const greek = Array.from({ length: 60 }, (_, i) => tip(`g${i}`, 'mac', `Το Mac κάνει κάτι περίεργο με τον ήχο όταν κοιμάται, σημείωση ${i}.`, { at: i }));
  const gn = startupNote(greek, 2);
  assert.ok(Buffer.byteLength(gn) <= STARTUP_MAX, `${Buffer.byteLength(gn)} bytes`);
  assert.match(gn, /manager\/coffee add/);
  // One room's word about the owner goes to every room only once a second room vouches for it.
  assert.doesNotMatch(startupNote([tip('q1', 'owner', 'The owner wants rooms to merge without a button.')], 2), /merge without/);
  assert.match(startupNote([tip('q2', 'owner', 'They review by screenshots.', { from: 'Lamp, Lumen' })], 2), /\[q2\]/);
  // A full board must not leave "Waiting for a second room" as an empty heading.
  const full = Array.from({ length: 40 }, (_, i) => tip(`b${i}`, 'tip', `A board tip number ${i} that two rooms both ran into on this Mac.`, { from: 'Lamp, Lumen' }));
  const mixed = startupNote([...full, tip('w9', 'mac', 'A waiting tip.', { at: 50 })], 2);
  assert.match(mixed, /Waiting for a second room[^\n]*\n- \[w9\]/, 'waiting tips always get room');
  assert.doesNotMatch(startupNote(full, 2), /Waiting for a second room/, 'no heading without a tip under it');
  assert.ok(mixed.length <= STARTUP_MAX);

  const data = mkdtempSync(join(tmpdir(), 'th-'));
  saveCoffee(data, { tips, removed: [], rooms: 3 });
  assert.match(readFileSync(join(data, 'coffee', 'startup.md'), 'utf8'), /\[w1\]/);
  assert.match(readFileSync(join(data, 'coffee', 'board.md'), 'utf8'), /Merge only on their button/);
  assert.equal(loadCoffee(data).tips.length, 2);
  assert.equal(loadCoffee(data).rooms, 3);
});

test('the start-up hook prints the coffee note after the name tag, only in rooms', () => {
  const data = mkdtempSync(join(tmpdir(), 'th-'));
  const hook = new URL('../hooks/office-name.sh', import.meta.url).pathname;
  mkdirSync(join(data, 'tags'));
  mkdirSync(join(data, 'coffee'));
  writeFileSync(join(data, 'tags', '-d-lamp.md'), 'You are Lena.');
  const run = (dir: string) => execFileSync('sh', [hook], { env: { ...process.env, CM_DATA_DIR: data, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
  assert.equal(run('/d/lamp'), 'You are Lena.', 'coffee off (no note): just the tag');
  writeFileSync(join(data, 'coffee', 'startup.md'), '# Coffee room\n- [w1] tip');
  assert.match(run('/d/lamp'), /You are Lena\.\n\n# Coffee room\n- \[w1\] tip/);
  assert.equal(run('/d/elsewhere'), '', 'not a room: nothing');
});

test('every room is told about the board and manager/coffee', () => {
  const skill = readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /coffee\/board\.md/);
  assert.match(skill, /manager\/coffee add/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('manager/coffee'), 'the command ships in the package');
});

test('no credentials, and at most three new tips per room a day', () => {
  for (const bad of ['Set GH_PAT=ghp_abcdefghijklmnop to push', 'Use ghp_abcdefghijklmnopqrstu', 'The key AKIAABCDEFGHIJKLMNOP works', 'Bearer header fixes it', 'Paste sk-abc into the box', 'Store the secret in keychain', 'Value aGVsbG8gd29ybGQgdGhpcyBpcyBsb25n is right'])
    assert.equal(applyPosts(BIG, [add('/d/lamp', 'tip', bad)], room, 1).state.tips.length, 0, bad);
  assert.equal(applyPosts(BIG, [add('/d/lamp', 'mac', 'Peekaboo needs Screen Recording in System Settings.')], room, 1).state.tips.length, 1);
  const five = Array.from({ length: 5 }, (_, i) => add('/d/lamp', 'tip', `Lamp found useful thing number ${i}.`));
  const r = applyPosts(BIG, [...five, add('/d/lumen', 'tip', 'Lumen found a useful thing too.')], room, 1);
  assert.equal(r.state.tips.filter((t) => t.from === 'Lamp').length, POSTS_PER_DAY);
  assert.equal(r.state.tips.filter((t) => t.from === 'Lumen').length, 1);
  assert.equal(applyPosts(r.state, [add('/d/lamp', 'tip', 'A day later, another one.', 2 * 86_400_000)], room, 2 * 86_400_000).state.tips.length, 5, 'a new day, a new allowance');
});

test('the owner removes a tip with its x, and it never comes back', () => {
  const s = { tips: [tip('a1', 'mac', 'The Claude app shell has no local network access.')], removed: [] };
  const gone = removeTip(s, 'a1')!;
  assert.equal(gone.tips.length, 0);
  assert.deepEqual(gone.removed, ['The Claude app shell has no local network access.']);
  assert.equal(removeTip(gone, 'a1'), undefined);
  assert.equal(applyPosts(gone, [add('/d/lumen', 'mac', 'The Claude app shell has no local network access')], room, 5).state.tips.length, 0);
});

test('the board stays short: 30-day fade (not tips about the owner on the board), 10 per section, 40 in all', () => {
  const now = 100 * FADE_MS;
  const old = now - FADE_MS - 1;
  const kept = prune([tip('g', 'owner', 'They review by screenshots.', { from: 'Lamp, Lumen', last: old }), tip('g1', 'owner', 'They like blue.', { last: old }), tip('t', 'tip', 'Old tip.', { last: old }), tip('n', 'tip', 'New tip.', { last: now })], now, 2);
  assert.deepEqual(kept.map((t) => t.id), ['g', 'n'], 'an unconfirmed tip fades; one about the owner stays once it is on the board');
  const many = Array.from({ length: 15 }, (_, i) => tip(`b${i}`, 'bug', `Bug ${i}.`, { seen: i, last: now }));
  const bugs = prune(many, now);
  assert.equal(bugs.length, 10);
  assert.ok(bugs.every((t) => t.seen >= 5), 'the most confirmed stay');
  const all = (['owner', 'tip', 'bug', 'mac'] as const).flatMap((k) => Array.from({ length: 12 }, (_, i) => tip(`${k}${i}`, k, `${k} ${i}.`, { last: now })));
  assert.equal(prune(all, now).length, 40);
});

test('in a big office only tips two rooms brought up are on the board; the rest wait and rank last', () => {
  const now = 10;
  const tips = [tip('one', 'tip', 'The render tool runs headless with -t.', { seen: 7, last: now }), tip('two', 'tip', 'Merge only on their button.', { from: 'Lamp, Lumen', seen: 2, last: now })];
  const md = renderBoard(tips, 2);
  assert.match(md, /Merge only on their button/);
  assert.doesNotMatch(md, /runs headless/, 'confirmed 7 times, but by one room: not shown');
  const crowd = Array.from({ length: 12 }, (_, i) => tip(`s${i}`, 'tip', `Solo ${i}.`, { seen: 9, last: now }));
  assert.ok(prune([...crowd, tips[1]!], now, 2).some((t) => t.id === 'two'), 'a tip from two rooms beats any number of one-room confirmations');
});

test('withoutRooms: a private room leaves every tip and the last post; tips only it brought go', () => {
  const t = (id: string, from: string): Tip => ({ id, kind: 'mac', text: `tip ${id}`, from, at: 1, seen: 1, last: 1 });
  const s = { tips: [t('a', 'Ledger'), t('b', 'Lumen, Clinic'), t('c', 'Lumen')], removed: [], last: { at: 1, who: [{ id: 'lead:x', name: 'Ledger', line: 'private' }, { id: 'lead:m', name: 'Lumen', line: 'hi' }] } };
  const out = withoutRooms(s, ['Ledger', 'Clinic']);
  assert.deepEqual(out.tips.map((x) => [x.id, x.from]), [['b', 'Lumen'], ['c', 'Lumen']]);
  assert.deepEqual(out.last!.who.map((w) => w.name), ['Lumen']);
  assert.equal(withoutRooms(out, ['Ledger', 'Clinic']), out, 'nothing to take off: the same state, so nothing is saved');
  assert.equal(withoutRooms(s, []), s);
});

test('posts wait in the queue until the office knows its rooms', () => {
  const src = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function coffeeRoom('));
  assert.ok(body.indexOf('if (!floors.latest()) return;') < body.indexOf('takePosts(DATA_DIR);\n  if (posts.length)'), 'no posts taken before the floor is known');
});
