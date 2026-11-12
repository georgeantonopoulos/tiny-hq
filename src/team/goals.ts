// Room goals: one line per room that the owner sets on the whiteboard ("Goal: Atlas 1.5 in the
// App Store and 100 paying users"), in ~/.tiny-hq/manager/goals.json. The manager reads them in their
// office list and, in the daily brief, offers the owner one next move toward the goal for every room
// with no open job, so the office is proactive rather than sitting idle. Only the owner sets
// them: the whiteboard is the only writer.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Goal {
  goal: string;
  at: number;
}

export const MAX_GOAL = 200;
const clean = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function goalsPath(managerNotesDir: string): string {
  return join(managerNotesDir, 'goals.json');
}

// Keyed by the room's project folder.
export function loadGoals(path: string): Record<string, Goal> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { goals?: unknown };
    const out: Record<string, Goal> = {};
    if (!raw.goals || typeof raw.goals !== 'object') return out;
    for (const [k, v] of Object.entries(raw.goals as Record<string, unknown>)) {
      if (!k.startsWith('/') || !v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      const goal = typeof o.goal === 'string' ? clean(o.goal, MAX_GOAL) : '';
      if (goal) out[k] = { goal, at: typeof o.at === 'number' ? o.at : 0 };
    }
    return out;
  } catch {
    return {};
  }
}

// Sets (or, with an empty goal, clears) a room's goal. Returns the cleaned goal ('' when cleared).
export function setGoal(path: string, folder: string, goal: string, now = Date.now()): string {
  const goals = loadGoals(path);
  const g = clean(goal, MAX_GOAL);
  if (g) goals[folder] = { goal: g, at: now };
  else delete goals[folder];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ goals }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return g;
}
