import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corridorRows, gap, pickScene, SCENES, seeded, wander, weights, type AmbientContext, type Scene } from '../web/app/ambience.ts';
import type { TileKind } from '../web/app/floorplan.ts';

const day: AmbientContext = { night: false, busy: 1, people: 4, hasGarden: true, hasHalls: true };
const night: AmbientContext = { ...day, night: true };

// h = hall, r = room
const grid: TileKind[][] = ['hhhhhhhhhh', 'hrrrhrrrrh', 'hrrrhrrrrh', 'hhhhhhhhhh', 'hrrrrrrrrh', 'hhhhhhhhhh'].map((row) => [...row].map((c) => (c === 'h' ? 'hall' : 'room')));

test('a scene never plays twice running, and resting scenes are skipped', () => {
  const rnd = seeded(1);
  let last: Scene | undefined;
  for (let i = 0; i < 500; i++) {
    const s = pickScene(day, rnd, last, (x) => x !== 'birds');
    assert.ok(s);
    assert.notEqual(s, last);
    assert.notEqual(s, 'birds');
    last = s;
  }
});

test('night and day get their own scenes', () => {
  const seen = (c: AmbientContext) => {
    const rnd = seeded(7);
    const out = new Set<Scene>();
    for (let i = 0; i < 2000; i++) out.add(pickScene(c, rnd)!);
    return out;
  };
  const d = seen(day);
  const n = seen(night);
  for (const s of ['shootingstar', 'fireflies', 'neonflicker'] as const) assert.ok(!d.has(s) && n.has(s), s);
  for (const s of ['birds', 'pigeon', 'butterfly'] as const) assert.ok(d.has(s) && !n.has(s), s);
});

test('tumbleweed only when nobody is working; garden and corridor scenes need the floor for them', () => {
  assert.equal(weights({ ...day, busy: 1 }).tumbleweed, 0);
  assert.ok(weights({ ...day, busy: 0 }).tumbleweed > 0);
  assert.equal(weights({ ...day, busy: 0, people: 0 }).tumbleweed, 0);
  const bare = weights({ ...night, hasGarden: false, hasHalls: false });
  assert.equal(bare.fireflies, 0);
  assert.equal(bare.roomba, 0);
  assert.equal(pickScene({ ...day, hasGarden: false, hasHalls: false }, seeded(3), undefined, () => false), undefined);
  for (const s of SCENES) assert.ok(weights(day)[s] >= 0);
});

test('the wait between scenes is 5 to 12 s, longer when busy', () => {
  const rnd = seeded(9);
  for (let i = 0; i < 200; i++) {
    const g = gap(day, rnd);
    assert.ok(g >= 5_000 && g <= 12_000);
  }
  assert.ok(gap({ ...day, busy: 3 }, () => 0) > gap(day, () => 0));
});

test('the vacuum walks corridor tile to corridor tile', () => {
  for (let seed = 1; seed < 30; seed++) {
    const path = wander(grid, seeded(seed), 40);
    assert.equal(path.length, 41);
    path.forEach((p, i) => {
      assert.equal(grid[p.y]![p.x], 'hall');
      if (i) assert.equal(Math.abs(p.x - path[i - 1]!.x) + Math.abs(p.y - path[i - 1]!.y), 1);
    });
  }
  assert.deepEqual(wander([['room']], seeded(1), 5), []);
});

test('tumbleweed rows skip the front row and short runs', () => {
  const rows = corridorRows(grid, 6);
  assert.deepEqual(rows.map((r) => r.y), [3, 5]);
  assert.ok(rows.every((r) => r.x1 - r.x0 + 1 >= 6));
});
