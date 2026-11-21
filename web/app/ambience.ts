// Little scenes around the building that cost nothing: no tokens, no model, no
// server: plain dice rolls in the page, weighted by what the office is like right now (day or
// night, how many people are working, what the floor has room for), never the same scene twice
// running, and each scene resting a while before it may come back. Pure logic only, so it is
// testable in Node; the drawing is in ambient-fx.ts.

import type { TileKind } from './floorplan.ts';

export const SCENES = ['birds', 'pigeon', 'roomba', 'drone', 'tumbleweed', 'butterfly', 'shootingstar', 'fireflies', 'balloon', 'neonflicker'] as const;
export type Scene = (typeof SCENES)[number];

export interface AmbientContext {
  night: boolean;
  busy: number; // people typing right now
  people: number; // everyone on the floor
  hasGarden: boolean; // an atrium or planter strip for butterflies and fireflies
  hasHalls: boolean; // corridors to wander
}

// How likely each scene is right now (0 = not now). The office's mood decides: a quiet office
// gets tumbleweed, a busy one gets parcels, the night gets stars and fireflies.
export function weights(c: AmbientContext): Record<Scene, number> {
  const quiet = c.people > 0 && c.busy === 0;
  const busyShare = c.people ? c.busy / c.people : 0;
  return {
    birds: c.night ? 0 : 3,
    pigeon: c.night ? 0 : 2,
    roomba: c.hasHalls ? (c.night ? 4 : 2) : 0,
    drone: c.night ? 0.5 : 1 + busyShare * 4,
    tumbleweed: c.hasHalls && quiet ? 3 : 0,
    butterfly: c.hasGarden && !c.night ? 2 : 0,
    shootingstar: c.night ? 3 : 0,
    fireflies: c.hasGarden && c.night ? 3 : 0,
    balloon: c.night ? 0.3 : 1,
    neonflicker: c.night ? 2 : 0,
  };
}

// The scene to play next, or none. `last`: the scene played last (never twice running);
// `rested(s)`: false while a scene is still resting from its last showing.
export function pickScene(c: AmbientContext, rnd: () => number, last?: Scene, rested: (s: Scene) => boolean = () => true): Scene | undefined {
  const w = weights(c);
  const pool = SCENES.filter((s) => s !== last && rested(s) && w[s] > 0);
  const total = pool.reduce((a, s) => a + w[s], 0);
  if (!total) return undefined;
  let r = rnd() * total;
  for (const s of pool) {
    r -= w[s];
    if (r < 0) return s;
  }
  return pool[pool.length - 1];
}

// How long a scene rests before it may come back, in ms.
export const REST: Record<Scene, number> = {
  birds: 40_000,
  pigeon: 60_000,
  roomba: 70_000,
  drone: 60_000,
  tumbleweed: 90_000,
  butterfly: 45_000,
  shootingstar: 25_000,
  fireflies: 60_000,
  balloon: 90_000,
  neonflicker: 30_000,
};

// The wait before the next scene: 5 to 12 s, so something is nearly always going on somewhere
// (scenes overlap); a little longer when the office is busy so the floor stays readable.
export function gap(c: AmbientContext, rnd: () => number): number {
  return (5 + rnd() * 7) * 1000 * (c.busy > 2 ? 1.3 : 1);
}

// A small seeded random source (mulberry32), so a scene's path can be replayed in tests.
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Tile {
  x: number;
  y: number;
}

const DIRS: Tile[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

// A wander through the corridors, tile by tile: keeps going straight most of the time, turns at
// junctions now and then, turns back only at a dead end. Every step is a corridor tile next to
// the one before. Used by the robot vacuum.
export function wander(grid: TileKind[][], rnd: () => number, steps: number, start?: Tile): Tile[] {
  const hall = (x: number, y: number) => grid[y]?.[x] === 'hall';
  const halls: Tile[] = [];
  grid.forEach((row, y) => row.forEach((k, x) => k === 'hall' && halls.push({ x, y })));
  if (!halls.length) return [];
  let at = start && hall(start.x, start.y) ? start : halls[Math.floor(rnd() * halls.length)]!;
  let dir: Tile | undefined;
  const path = [at];
  for (let i = 0; i < steps; i++) {
    const open = DIRS.filter((d) => hall(at.x + d.x, at.y + d.y));
    if (!open.length) break;
    const ahead = dir && open.find((d) => d.x === dir!.x && d.y === dir!.y);
    const sideways = open.filter((d) => !dir || (d.x !== -dir.x || d.y !== -dir.y));
    if (ahead && rnd() < 0.8) dir = ahead;
    else if (sideways.length) dir = sideways[Math.floor(rnd() * sideways.length)]!;
    else dir = open[0]!; // dead end: turn back
    at = { x: at.x + dir.x, y: at.y + dir.y };
    path.push(at);
  }
  return path;
}

// Straight runs of corridor along a row, at least `min` tiles long, for a tumbleweed to roll
// down. The front foyer row (y = 0) is left out: the front wall is drawn over it.
export function corridorRows(grid: TileKind[][], min = 6): { y: number; x0: number; x1: number }[] {
  const runs: { y: number; x0: number; x1: number }[] = [];
  grid.forEach((row, y) => {
    if (y === 0) return;
    let x0 = -1;
    for (let x = 0; x <= row.length; x++) {
      if (row[x] === 'hall') {
        if (x0 < 0) x0 = x;
      } else if (x0 >= 0) {
        if (x - x0 >= min) runs.push({ y, x0, x1: x - 1 });
        x0 = -1;
      }
    }
  });
  return runs;
}

// The sign's lettering: the office name in capitals, word gaps doubled.
export function signWord(name: string): string {
  return (name.trim() || 'Tiny HQ').toUpperCase().replace(/\s+/g, '  ');
}
