// Who has a room on the floor. The owner decides: a room that has a spot keeps it, however
// quiet it gets, until they send it to the archive cupboard on a button (a room that quietly
// dropped off overnight because another project got busy was a surprise nobody asked for).
// New projects only take a free spot; a full floor never swaps anyone out.
// Kept in ~/.tiny-hq/floor.json: { seated: [folders on the floor], away: [folders the
// owner sent to the cupboard] }. Read on every scan, so a change shows without a restart.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Seats {
  seated: string[];
  away: string[];
}

export const floorPath = (dataDir: string) => join(dataDir, 'floor.json');

const folders = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((p): p is string => typeof p === 'string' && /^\/[^\x00-\x1f\x7f]{1,400}$/.test(p)))].slice(0, 200) : [];

// undefined: no file yet (the first scan seats the busiest, as before).
export function loadSeats(path: string): Seats | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Seats>;
    return { seated: folders(raw.seated), away: folders(raw.away) };
  } catch {
    // A broken file must not empty the floor: keep everyone where the last good scan put them.
    return undefined;
  }
}

export function saveSeats(path: string, s: Seats): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ seated: folders(s.seated), away: folders(s.away) }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// candidates: every project that could have a room, busiest first (pinned first), with
// the owner's archived and hidden folders already left out. Returns the floor in that order.
// Rooms already seated stay, even past `max`; free spots go to the busiest newcomers;
// pinned folders always have a spot.
export function seatFloor(candidates: readonly string[], seats: Seats | undefined, max: number, pinned: readonly string[] = []): string[] {
  const away = new Set(seats?.away ?? []);
  const open = candidates.filter((p) => !away.has(p));
  if (!seats) return open.slice(0, max);
  const keep = new Set([...seats.seated, ...pinned].filter((p) => open.includes(p)));
  for (const p of open) {
    if (keep.size >= max) break;
    keep.add(p);
  }
  return open.filter((p) => keep.has(p));
}

// The owner sent a room to the cupboard (their pick on a button).
export function sendAway(s: Seats, folder: string): Seats {
  return { seated: s.seated.filter((p) => p !== folder), away: [...s.away.filter((p) => p !== folder), folder] };
}

// The owner brought a room back: it gets a spot now, even on a full floor.
export function bringBack(s: Seats, folder: string): Seats {
  return { seated: [...s.seated.filter((p) => p !== folder), folder], away: s.away.filter((p) => p !== folder) };
}
