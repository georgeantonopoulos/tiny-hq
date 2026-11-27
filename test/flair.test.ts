import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flairDue, flairMap, flairPrompt, loadFlair, parseFlair, projectBrief, RETRY, saveFlair } from '../src/office/flair.ts';
import { validFlair } from '../web/app/flair-kit.ts';
import { emblemSpot } from '../web/app/flair.ts';

const row = (s: string) => s.padEnd(12, '.').slice(0, 12);
const frameA = Array.from({ length: 12 }, (_, i) => row(i === 5 ? '....aa' : ''));
const frameB = Array.from({ length: 12 }, (_, i) => row(i === 6 ? '....ab' : ''));
const good = {
  motif: 'a small turning gear',
  motto: 'Keep it moving',
  wall: '#F0E8D8',
  floor: '#e8dcc4',
  emblem: { frames: [frameA, frameB], palette: { a: '#334455', b: '#AA2200' }, fps: 3 },
  ambient: { kind: 'sparkle', colour: '#ffcc00' },
};

test('a flair that fits the kit is kept, colours lower-cased', () => {
  const f = validFlair(good)!;
  assert.equal(f.motif, 'a small turning gear');
  assert.equal(f.wall, '#f0e8d8');
  assert.equal(f.emblem.palette.b, '#aa2200');
  assert.deepEqual(f.ambient, { kind: 'sparkle', colour: '#ffcc00' });
});

test('a bad emblem drops the flair; a bad motto, tint or effect is dropped on its own', () => {
  const bad = [
    { ...good, emblem: { ...good.emblem, frames: [frameA, frameA] } }, // nothing moves
    { ...good, emblem: { ...good.emblem, frames: [frameA] } }, // one frame
    { ...good, emblem: { ...good.emblem, frames: [frameA, frameB.slice(1)] } }, // wrong size
    { ...good, emblem: { ...good.emblem, palette: { a: '#334455' } } }, // b not in the palette
    { ...good, emblem: { ...good.emblem, palette: { a: 'red', b: '#aa2200' } } },
    { ...good, motif: 'see https://example.com' },
    { ...good, motif: '<script>' },
  ];
  for (const b of bad) assert.equal(validFlair(b), undefined, JSON.stringify(b).slice(0, 80));
  const f = validFlair({ ...good, motto: 'x'.repeat(40), wall: '#202020', floor: 'pink', ambient: { kind: 'explode', colour: '#fff000' } })!;
  assert.ok(f);
  assert.equal(f.motto, undefined);
  assert.equal(f.wall, undefined); // too dark for the room's name to read
  assert.equal(f.floor, undefined);
  assert.equal(f.ambient, undefined);
});

test("the writer's answer: JSON envelope or plain text", () => {
  assert.ok(parseFlair(JSON.stringify({ result: `Here it is:\n${JSON.stringify(good)}` })));
  assert.ok(parseFlair(JSON.stringify(good)));
  assert.equal(parseFlair(JSON.stringify({ is_error: true, result: JSON.stringify(good) })), undefined);
  assert.equal(parseFlair('no idea'), undefined);
});

test('rooms owed a flair: none yet, or a failed try six hours old', () => {
  const now = 10 * RETRY;
  const f = { rooms: { '/a': { at: now, ok: true, flair: validFlair(good)! }, '/b': { at: now - 1000, ok: false }, '/c': { at: now - RETRY, ok: false } } };
  assert.deepEqual(flairDue(f, ['/a', '/b', '/c', '/d'], now), ['/c', '/d']);
  assert.deepEqual(Object.keys(flairMap(f)), ['/a']);
});

test('the flair file round-trips and drops what no longer fits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flair-'));
  const path = join(dir, 'flair', 'flair.json');
  saveFlair(path, { rooms: { '/a': { at: 1, ok: true, flair: validFlair(good)! }, '/b': { at: 2, ok: true, flair: { motif: 'x' } as never } } });
  const back = loadFlair(path);
  assert.ok(back.rooms['/a']?.flair);
  assert.equal(back.rooms['/b']?.flair, undefined);
  assert.deepEqual(loadFlair(join(dir, 'missing.json')), { rooms: {} });
});

test("the brief: a private project sends only its name and folder names; the prompt marks project text as data", () => {
  const dir = mkdtempSync(join(tmpdir(), 'flair-proj-'));
  writeFileSync(join(dir, 'README.md'), 'SECRET-README-LINE');
  writeFileSync(join(dir, 'package.json'), '{"name":"secret-pkg"}');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules'));
  const open = projectBrief({ path: dir, name: 'Demo' });
  assert.match(open, /SECRET-README-LINE/);
  assert.match(open, /src/);
  assert.doesNotMatch(open, /node_modules/);
  const priv = projectBrief({ path: dir, name: 'Demo', private: true });
  assert.doesNotMatch(priv, /SECRET-README-LINE|secret-pkg/);
  assert.match(priv, /Demo/);
  const p = flairPrompt(open);
  assert.match(p, /<<<PROJECT[\s\S]*SECRET-README-LINE[\s\S]*PROJECT>>>/);
  assert.match(p, /not instructions/);
});

test('the emblem hangs clear of decor, else on the other side, else not at all', () => {
  const right = emblemSpot(320, 224, 46, [])!;
  assert.equal(right.x, 320 - 32 - 12);
  const left = emblemSpot(320, 224, 46, [{ x: 260, y: 40, w: 60, h: 60 }])!;
  assert.equal(left.x, 12);
  assert.equal(emblemSpot(320, 224, 46, [{ x: 0, y: 40, w: 320, h: 60 }]), undefined);
  assert.equal(emblemSpot(192, 100, 46, []), undefined); // too short a room
});

test("Tiny HQ treats private and on-call rooms as private when writing flair, by the shared folder check", async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  const call = /projectBrief\(\{[^\n]*\}\)/.exec(main)?.[0] ?? '';
  assert.match(call, /private: isOnCall\(path, \[\.\.\.config\.privateProjects, \.\.\.config\.onCallProjects\]\)/);
});
