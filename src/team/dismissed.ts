// What the owner doesn't want actioned: suggestions and jobs they dismissed with the
// × on the whiteboard, in ~/.tiny-hq/manager/dismissed.json. The whiteboard
// hides them, and the manager reads the file so they never suggests or hands them out again.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dismissKey } from '../../web/app/notebook.ts';

export { dismissKey };

export interface Dismissed {
  room: string; // room name as the whiteboard shows it
  text: string; // the suggestion or job title, as the owner saw it
  job?: string; // the job id, when it was an open job
  waitingFor?: string; // that job was waiting on the owner for this: Bring back restores it (and their button)
  at: number;
}

const MAX = 200;
const clean = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function dismissedPath(managerNotesDir: string): string {
  return join(managerNotesDir, 'dismissed.json');
}

export function loadDismissed(path: string): Dismissed[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { dismissed?: unknown };
    if (!Array.isArray(raw.dismissed)) return [];
    return raw.dismissed.flatMap((d): Dismissed[] => {
      if (!d || typeof d !== 'object') return [];
      const o = d as Record<string, unknown>;
      if (typeof o.room !== 'string' || typeof o.text !== 'string' || !clean(o.text, 600)) return [];
      const item: Dismissed = { room: clean(o.room, 100), text: clean(o.text, 600), at: typeof o.at === 'number' ? o.at : 0 };
      if (typeof o.job === 'string' && o.job) item.job = clean(o.job, 60);
      if (item.job && typeof o.waitingFor === 'string' && o.waitingFor.trim()) item.waitingFor = clean(o.waitingFor, 300);
      return [item];
    });
  } catch {
    return [];
  }
}

function save(path: string, list: Dismissed[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ dismissed: list }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// The owner brought it back (undo on the whiteboard). Returns what was removed, if it was there.
export function removeDismissed(path: string, room: string, text: string): Dismissed | undefined {
  const key = dismissKey(clean(room, 100), clean(text, 600));
  const list = loadDismissed(path);
  const gone = list.find((d) => dismissKey(d.room, d.text) === key);
  if (gone) save(path, list.filter((d) => d !== gone));
  return gone;
}

// Adds it (once); the oldest drop off past MAX. Returns the cleaned item.
export function addDismissed(path: string, room: string, text: string, job?: string, now = Date.now(), waitingFor?: string): Dismissed {
  const item: Dismissed = { room: clean(room, 100), text: clean(text, 600), at: now, ...(job ? { job: clean(job, 60) } : {}), ...(job && waitingFor ? { waitingFor: clean(waitingFor, 300) } : {}) };
  const key = dismissKey(item.room, item.text);
  const list = [...loadDismissed(path).filter((d) => dismissKey(d.room, d.text) !== key), item].slice(-MAX);
  save(path, list);
  return item;
}
