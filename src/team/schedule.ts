// The manager's timetable: the office's own list of scheduled tasks, in
// ~/.tiny-hq/manager/schedule.json. The office runs them (they survive
// restarts and new manager conversations); the manager adds and changes them with
// manager/schedule; the owner sees them on the timetable in the manager's office and can
// switch each one on or off.
//
// Two kinds of "when", kept simple enough to read at a glance:
//   { daily: "08:30" }              every day at 08:30
//   { everyHours: 2, minute: 17 }   every 2 hours at :17 (00:17, 02:17, ...)
// A task that comes due while the Mac is asleep runs once when it's back.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type When = { daily: string } | { everyHours: number; minute: number };

export interface Task {
  id: string; // short slug, e.g. "daily-brief"
  title: string; // what the owner reads on the timetable
  when: When;
  prompt: string; // what the manager is asked to do when it runs
  enabled: boolean;
  until?: string; // YYYY-MM-DD: stops after this day
  lastRun?: number; // ms; set once the manager has the prompt
  since?: number; // ms; counts from here when it hasn't run (added, or switched back on)
  createdBy?: string; // "office", "Manager"
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function validWhen(w: unknown): When | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const o = w as Record<string, unknown>;
  if (typeof o.daily === 'string' && TIME.test(o.daily)) return { daily: o.daily };
  if (typeof o.everyHours === 'number' && Number.isInteger(o.everyHours) && o.everyHours >= 1 && o.everyHours <= 24) {
    const minute = typeof o.minute === 'number' && Number.isInteger(o.minute) && o.minute >= 0 && o.minute < 60 ? o.minute : 0;
    return { everyHours: o.everyHours, minute };
  }
  return undefined;
}

export function validTask(t: unknown): Task | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as Record<string, unknown>;
  const when = validWhen(o.when);
  if (typeof o.id !== 'string' || !ID.test(o.id) || typeof o.title !== 'string' || !o.title.trim() || typeof o.prompt !== 'string' || !o.prompt.trim() || !when) return undefined;
  return {
    id: o.id,
    title: o.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80),
    when,
    prompt: o.prompt.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, 2000),
    enabled: o.enabled !== false,
    ...(typeof o.until === 'string' && DAY.test(o.until) ? { until: o.until } : {}),
    ...(typeof o.lastRun === 'number' && o.lastRun > 0 ? { lastRun: o.lastRun } : {}),
    ...(typeof o.since === 'number' && o.since > 0 ? { since: o.since } : {}),
    ...(typeof o.createdBy === 'string' ? { createdBy: o.createdBy.slice(0, 30) } : {}),
  };
}

export function loadSchedule(path: string): Task[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { tasks?: unknown };
    const seen = new Set<string>();
    return (Array.isArray(raw.tasks) ? raw.tasks : []).map(validTask).filter((t): t is Task => !!t && !seen.has(t.id) && !!seen.add(t.id)).slice(0, 50);
  } catch {
    return [];
  }
}

export function saveSchedule(path: string, tasks: Task[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tasks }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// The office's own task: the manager's morning brief. Added once if missing.
export function withDailyBrief(tasks: Task[], at: string, prompt: string): Task[] {
  if (tasks.some((t) => t.id === 'daily-brief')) return tasks;
  return [{ id: 'daily-brief', title: 'Daily brief', when: { daily: at }, prompt, enabled: true, createdBy: 'office' }, ...tasks];
}

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The most recent time this task was meant to run, at or before `now`.
export function lastSlot(when: When, now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  if ('daily' in when) {
    const [h, m] = when.daily.split(':').map(Number) as [number, number];
    d.setHours(h, m);
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }
  // Slots at minute M of every Nth hour counted from midnight.
  d.setMinutes(when.minute);
  if (d > now) d.setHours(d.getHours() - 1);
  while (d.getHours() % when.everyHours !== 0) d.setHours(d.getHours() - 1);
  return d;
}

export function nextSlot(when: When, now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  if ('daily' in when) {
    const [h, m] = when.daily.split(':').map(Number) as [number, number];
    d.setHours(h, m);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  d.setMinutes(when.minute);
  if (d <= now) d.setHours(d.getHours() + 1);
  while (d.getHours() % when.everyHours !== 0) d.setHours(d.getHours() + 1);
  return d;
}

export function expired(t: Task, now: Date): boolean {
  return !!t.until && localDay(now) > t.until;
}

// Due: switched on, not past its end date, and a slot has passed since it last ran.
// A new task, or one switched back on, counts from then (`since`), so it waits for its next slot.
export function isDue(t: Task, now: Date): boolean {
  if (!t.enabled || expired(t, now)) return false;
  return lastSlot(t.when, now).getTime() > Math.max(t.lastRun ?? 0, t.since ?? 0);
}

export function describeWhen(w: When): string {
  if ('daily' in w) return `Every day at ${w.daily}`;
  const mm = `:${String(w.minute).padStart(2, '0')}`;
  return w.everyHours === 1 ? `Every hour at ${mm}` : `Every ${w.everyHours} hours at ${mm}`;
}

// A held job watches for its own event (Lesson 1, in code rather than in the manager's memory):
// `job hold` adds this task, `job go` / `job done` take it away. Every 2 hours until the
// hold ends; the office's checker does the looking, so the manager only hears when it happened.
export const holdWatchId = (jobId: string) => `hold-${jobId}`.slice(0, 41);
export function holdWatch(jobId: string, title: string, waitingFor: string, until: number, cli: string, now = Date.now()): Task {
  const end = new Date(until);
  return {
    id: holdWatchId(jobId),
    title: `Watch: ${title}`.slice(0, 80),
    when: { everyHours: 2, minute: (now / 60_000) % 60 | 0 },
    prompt: `Job ${jobId} ("${title}") is on hold, waiting for: ${waitingFor}. Has it happened? Look in email (if connected), or in the room's last action on the status page (status.md). When it has, the manager runs ${cli} go ${jobId}, tells the room its next step by SendMessage, and updates their notebook; if not, nothing to do.`,
    enabled: true,
    until: localDay(end),
    since: now,
    createdBy: 'office',
  };
}

// Where the timetable lives (next to the manager's notebook).
export function schedulePath(managerNotesDir: string): string {
  return `${managerNotesDir}/schedule.json`;
}
