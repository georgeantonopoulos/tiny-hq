import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bringBack, loadSeats, saveSeats, seatFloor, sendAway } from '../src/office/seats.ts';
import { layoutFloor } from '../src/office/layout.ts';

const ps = (n: number) => Array.from({ length: n }, (_, i) => `/d/p${i}`);

// A quiet room must not drop off overnight just because another project got busy.
test('a seated room keeps its spot when a busier newcomer shows up on a full floor', () => {
  const seated = ps(12);
  const busiest = ['/d/new', ...seated]; // the newcomer is now the busiest
  const floor = seatFloor(busiest, { seated, away: [] }, 12);
  assert.deepEqual(floor, seated);
  assert.ok(!floor.includes('/d/new'));
});

test('newcomers take free spots only, busiest first, and the floor keeps discovery order', () => {
  const floor = seatFloor(['/d/a', '/d/b', '/d/c', '/d/d'], { seated: ['/d/c'], away: [] }, 3);
  assert.deepEqual(floor, ['/d/a', '/d/b', '/d/c']);
});

test('with no record yet the busiest get the floor, as before', () => {
  assert.deepEqual(seatFloor(ps(14), undefined, 12), ps(12));
});

test('a room brought back gets a spot even on a full floor; one the owner sends away leaves', () => {
  const s = bringBack({ seated: ps(12), away: ['/d/back'] }, '/d/back');
  assert.equal(seatFloor([...ps(12), '/d/back'], s, 12).length, 13);
  const gone = sendAway(s, '/d/p11');
  const floor = seatFloor([...ps(12), '/d/back', '/d/x'], gone, 12);
  assert.ok(!floor.includes('/d/p11'));
  assert.ok(floor.includes('/d/back'));
  assert.ok(!floor.includes('/d/x'), 'a spot the owner freed is not refilled while the floor is still at 12');
});

test('pinned folders always have a spot', () => {
  assert.ok(seatFloor([...ps(12), '/d/pin'], { seated: ps(12), away: [] }, 12, ['/d/pin']).includes('/d/pin'));
});

test('a broken floor file never empties the floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-'));
  const path = join(dir, 'floor.json');
  writeFileSync(path, '{ not json');
  assert.equal(loadSeats(path), undefined);
  saveSeats(path, { seated: ['/d/a', 'bad', '/d/a'], away: [] });
  assert.deepEqual(loadSeats(path), { seated: ['/d/a'], away: [] });
});

test('the layout shows every seated room, past twelve', () => {
  const project = (i: number) => ({ id: `p${i}`, name: `P${i}`, path: `/d/p${i}`, sources: {}, sessions: 1, recentSessions: 1, lastActive: 0, activity: 0.5, times: [], titles: [] });
  const floor = layoutFloor(Array.from({ length: 15 }, (_, i) => project(i)) as never, 0, { onFloor: 13 });
  assert.equal(floor.rooms.filter((r) => r.kind === 'project').length, 13);
});

// Guard: the daemon seats the floor from the record, and only the owner's pick sends a room away.
test('the floor scan goes through seatFloor and saves who is seated', () => {
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  assert.match(main, /seatFloor\(/);
  assert.match(main, /saveFloorSeats\(/);
  assert.doesNotMatch(main, /onFloor = Math\.min\(MAX_ROOMS/);
  // A broken floor file is never overwritten (it holds the owner's cupboard picks).
  assert.match(main, /if \(!seats && existsSync\(floorPath\(DATA_DIR\)\)\) return;/);
});
