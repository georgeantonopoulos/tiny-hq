// Pure, deterministic procedural floor-plan analyzer.
// Classifies every tile outside the rooms into connected walkways (matching
// Office.route) and sized/context-aware common zones so there are no leftover
// grey-checkerboard deadzones. Zero PixiJS dependency so it can be unit-tested
// directly under Node.

import type { Floor } from '../../src/office/layout.ts';

export type TileKind = 'room' | 'hall' | 'pocket';

export type ZoneKind =
  | 'atrium'
  | 'recreation'
  | 'lounge_nook'
  | 'collab_bay'
  | 'bench_nook'
  | 'refreshments'
  | 'print_station'
  | 'planter_strip';

export interface FloorZone {
  id: string;
  kind: ZoneKind;
  x: number; // tile coordinates
  y: number;
  w: number;
  h: number;
  seed: number;
}

export interface Doorway {
  roomId: string;
  x: number; // door center in tile coordinates (may be .5 for odd room widths)
  y: number; // bottom wall y in tile coordinates
}

export interface FloorPlan {
  width: number;
  height: number;
  grid: TileKind[][];
  runner: boolean[][]; // true on main corridor tiles that carry the woven carpet runner
  zoneAt: (FloorZone | null)[][];
  zones: FloorZone[];
  doorways: Doorway[];
}

function hashInts(a: number, b: number, c: number, d: number): number {
  let h = 2166136261;
  for (const n of [a, b, c, d]) {
    h ^= n & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Finds the largest axis-aligned rectangle of `true` cells in `free`.
// Deterministic tie-breaking: prefers larger area, then smaller y, then smaller x.
function largestRect(free: boolean[][], W: number, H: number): Rect {
  const heights = new Int32Array(W);
  let best: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let bestArea = 0;

  for (let y = 0; y < H; y++) {
    const row = free[y]!;
    for (let x = 0; x < W; x++) heights[x] = row[x] ? heights[x]! + 1 : 0;

    // Monotonic stack of column indices.
    const stack: number[] = [];
    for (let x = 0; x <= W; x++) {
      const curH = x < W ? heights[x]! : 0;
      while (stack.length > 0 && heights[stack[stack.length - 1]!]! > curH) {
        const top = stack.pop()!;
        const rh = heights[top]!;
        const left = stack.length > 0 ? stack[stack.length - 1]! + 1 : 0;
        const rw = x - left;
        const area = rw * rh;
        const ry = y - rh + 1;
        if (area > bestArea || (area === bestArea && area > 0 && (ry < best.y || (ry === best.y && left < best.x)))) {
          bestArea = area;
          best = { x: left, y: ry, w: rw, h: rh };
        }
      }
      stack.push(x);
    }
  }
  return best;
}

function pickLeastUsed(candidates: readonly ZoneKind[], counts: Record<ZoneKind, number>, seed: number): ZoneKind {
  let minCount = Infinity;
  for (const kind of candidates) {
    if (counts[kind] < minCount) minCount = counts[kind];
  }
  const tied = candidates.filter((k) => counts[k] === minCount);
  return tied[seed % tied.length]!;
}

export function buildFloorPlan(floor: Floor): FloorPlan {
  const W = Math.max(1, Math.ceil(floor.width));
  const H = Math.max(1, Math.ceil(floor.height));

  const grid: TileKind[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => 'pocket'));
  const runner: boolean[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => false));
  const zoneAt: (FloorZone | null)[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => null));

  const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
  const setHall = (x: number, y: number, withRunner = false): void => {
    if (!inBounds(x, y)) return;
    if (grid[y]![x] === 'pocket') grid[y]![x] = 'hall';
    if (withRunner && grid[y]![x] === 'hall') runner[y]![x] = true;
  };

  // 1. Stamp rooms.
  for (const r of floor.rooms) {
    const kind: TileKind = 'room';
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.ceil(r.x + r.w));
    const y1 = Math.min(H, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) grid[y]![x] = kind;
    }
  }

  // 2. Carve guaranteed walkable hallways matching Office.route().
  const doorways: Doorway[] = [];
  const laneSpan = new Map<number, { maxRoomX: number; maxDoorX: number }>();

  for (const r of floor.rooms) {
    const dx = r.door?.x ?? r.x + r.w / 2;
    const dy = Math.floor(r.door?.y ?? r.y + r.h);
    const cy = Math.floor(r.corridorY ?? dy + 0.5);
    doorways.push({ roomId: r.id, x: dx, y: dy });

    // Door drop stem: 1 tile wide when room width is odd, 2 tiles wide when even.
    const stemLeft = Math.floor(dx - 0.5);
    const stemRight = Math.floor(dx + 0.49);
    const topY = Math.min(dy, cy);
    const botY = Math.max(dy, cy);
    for (let y = topY; y <= botY; y++) {
      for (let x = stemLeft; x <= stemRight; x++) setHall(x, y, false);
    }

    const prev = laneSpan.get(cy);
    const maxRoomX = Math.min(W - 1, Math.ceil(r.x + r.w) - 1);
    const maxDoorX = Math.min(W - 1, stemRight);
    if (!prev) laneSpan.set(cy, { maxRoomX, maxDoorX });
    else {
      prev.maxRoomX = Math.max(prev.maxRoomX, maxRoomX);
      prev.maxDoorX = Math.max(prev.maxDoorX, maxDoorX);
    }
  }

  // Horizontal corridor lanes for every row of rooms.
  const laneRows = [...laneSpan.keys()].sort((a, b) => a - b);
  for (const cy of laneRows) {
    const span = laneSpan.get(cy)!;
    // Extend stone hallway to the east wall when the row spans most of the floor
    // (leaving an incomplete half-row open for a larger atrium/lounge if short).
    const hallMaxX = span.maxRoomX >= W - 10 ? W - 1 : span.maxRoomX;
    for (let x = 0; x <= hallMaxX; x++) {
      setHall(x, cy, x <= span.maxDoorX);
    }
    // If the row directly below this corridor is completely free of rooms and another
    // room row starts right after it (e.g. the 2-tile avenue under the manager's row),
    // treat both rows as a spacious main concourse.
    const nextRow = cy + 1;
    const hasRowAfter = floor.rooms.some((r) => Math.floor(r.y) === cy + 2);
    if (hasRowAfter && nextRow < H) {
      let clear = true;
      for (let x = 0; x <= hallMaxX; x++) {
        if (grid[nextRow]![x] === 'room') {
          clear = false;
          break;
        }
      }
      if (clear) {
        for (let x = 0; x <= hallMaxX; x++) setHall(x, nextRow, false);
      }
    }
  }

  // Left-hand vertical spine (x = 0): Office.route() walks along x = 0 between rows.
  const minLaneY = laneRows.length > 0 ? laneRows[0]! : 0;
  const maxLaneY = laneRows.length > 0 ? laneRows[laneRows.length - 1]! : 0;
  for (let y = 0; y < H; y++) {
    const onWalkingSpine = laneRows.length > 0 && y >= minLaneY && y <= maxLaneY;
    setHall(0, y, onWalkingSpine);
  }

  // Top foyer / perimeter walkway (y = 0) connecting the front door cleanly to the spine.
  for (let x = 0; x < W; x++) {
    setHall(x, 0, false);
  }

  // 1-tile vertical cross-aisles between side-by-side rooms so rows connect cleanly.
  const aisleSeeds: [number, number][] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (grid[y]![x] === 'pocket' && grid[y]![x - 1] === 'room' && grid[y]![x + 1] === 'room') {
        aisleSeeds.push([x, y]);
      }
    }
  }
  for (const [ax, ay] of aisleSeeds) {
    setHall(ax, ay, false);
    for (let y = ay - 1; y >= 0 && grid[y]![ax] === 'pocket'; y--) {
      if (grid[y]![ax - 1] === 'room' || grid[y]![ax + 1] === 'room') setHall(ax, y, false);
      else break;
    }
    for (let y = ay + 1; y < H && grid[y]![ax] === 'pocket'; y++) {
      // Connect cleanly down into the horizontal corridor directly below this row.
      if (grid[y]![ax - 1] === 'room' || grid[y]![ax + 1] === 'room') {
        setHall(ax, y, false);
      } else {
        // Look ahead up to 3 tiles for a corridor lane so aisles never dead-end above shorter rooms.
        let reachesHall = false;
        for (let d = 1; d <= 3 && y + d < H; d++) {
          if (grid[y + d]![ax] === 'hall') {
            reachesHall = true;
            break;
          }
          if (grid[y + d]![ax] !== 'pocket') break;
        }
        if (reachesHall) setHall(ax, y, false);
        else break;
      }
    }
  }

  // Keep a 1-tile vertical aisle directly to the left of any room whose left neighbor
  // is a wide pocket (e.g. a narrow project room inside a wider column), so pockets
  // never crowd the neighboring room's outer wall.
  for (const r of floor.rooms) {
    const ax = Math.floor(r.x) - 1;
    if (ax <= 1) continue;
    const y0 = Math.max(1, Math.floor(r.y));
    const y1 = Math.min(H - 1, Math.ceil(r.y + r.h));
    // Only carve when there's actually a wide open pocket (2+ tiles) to the left of ax.
    let widePocket = true;
    for (let y = y0; y < y1; y++) {
      if (grid[y]![ax] !== 'pocket' || grid[y]![ax - 1] !== 'pocket') {
        widePocket = false;
        break;
      }
    }
    if (widePocket) {
      for (let y = y0; y < y1; y++) setHall(ax, y, false);
    }
  }

  // 3. Decompose all remaining 'pocket' tiles into balanced maximal rectangles.
  const free: boolean[][] = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => grid[y]![x] === 'pocket'));
  const rects: Rect[] = [];

  for (;;) {
    const best = largestRect(free, W, H);
    if (best.w === 0 || best.h === 0 || best.w * best.h < 2) break;

    // Subdivide very wide open expanses with a 1-tile stone walkway so large wings
    // become distinct, human-scale spaces.
    if (best.w >= 16 && best.h >= 4) {
      const splitX = best.x + Math.floor(best.w / 2);
      if (splitX > best.x + 2 && splitX < best.x + best.w - 3) {
        for (let y = best.y; y < best.y + best.h; y++) {
          free[y]![splitX] = false;
          setHall(splitX, y, false);
        }
        continue;
      }
    }

    // Subdivide very tall open expanses horizontally (e.g. multiple empty rows).
    if (best.h >= 12 && best.w >= 4) {
      const splitY = best.y + Math.floor(best.h / 2);
      if (splitY > best.y + 3 && splitY < best.y + best.h - 4) {
        for (let x = best.x; x < best.x + best.w; x++) {
          free[splitY]![x] = false;
          setHall(x, splitY, false);
        }
        continue;
      }
    }

    rects.push(best);
    for (let y = best.y; y < best.y + best.h; y++) {
      for (let x = best.x; x < best.x + best.w; x++) free[y]![x] = false;
    }
  }

  // Absorb any remaining isolated 1x1 pocket tiles into 'hall' so zero deadzones remain.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (free[y]![x]) {
        free[y]![x] = false;
        setHall(x, y, false);
      }
    }
  }

  // 4. Deterministically classify each pocket rectangle into a context-aware zone.
  rects.sort((a, b) => a.y - b.y || a.x - b.x);
  const counts: Record<ZoneKind, number> = {
    atrium: 0,
    recreation: 0,
    lounge_nook: 0,
    collab_bay: 0,
    bench_nook: 0,
    refreshments: 0,
    print_station: 0,
    planter_strip: 0,
  };

  const zones: FloorZone[] = rects.map((r, i) => {
    const seed = hashInts(r.x, r.y, r.w, r.h);
    let kind: ZoneKind;

    if (r.w >= 5 && r.h >= 4) {
      kind = pickLeastUsed(['atrium', 'recreation', 'lounge_nook'], counts, seed);
    } else if ((r.w >= 5 && r.h >= 3) || (r.w >= 4 && r.h >= 4)) {
      kind = pickLeastUsed(['recreation', 'lounge_nook', 'collab_bay'], counts, seed);
    } else if ((r.w >= 4 && r.h >= 3) || (r.w >= 3 && r.h >= 4)) {
      kind = pickLeastUsed(['lounge_nook', 'collab_bay'], counts, seed);
    } else if (r.w >= 3 && r.h >= 3) {
      kind = pickLeastUsed(['collab_bay', 'lounge_nook', 'print_station'], counts, seed);
    } else if (r.w >= 3 && r.h === 2) {
      kind = pickLeastUsed(['bench_nook', 'refreshments', 'print_station'], counts, seed);
    } else if (r.w === 2 && r.h >= 3) {
      kind = pickLeastUsed(['print_station', 'refreshments', 'bench_nook'], counts, seed);
    } else if (r.w === 2 && r.h === 2) {
      kind = pickLeastUsed(['refreshments', 'planter_strip', 'print_station'], counts, seed);
    } else {
      kind = 'planter_strip';
    }

    counts[kind]++;
    const zone: FloorZone = { id: `zone:${i}:${r.x},${r.y}`, kind, x: r.x, y: r.y, w: r.w, h: r.h, seed };
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) zoneAt[y]![x] = zone;
    }
    return zone;
  });

  return { width: W, height: H, grid, runner, zoneAt, zones, doorways };
}
