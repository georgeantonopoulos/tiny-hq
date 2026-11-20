// Fewer interruptions: a button that can wait waits, and reaches the owner together with the others
// at 09:00 and 17:00 instead of one question mark at a time. Posts and deploys, passwords and the
// camera stay instant (a pass with a clock on it, or someone signed out mid-task), and so does
// anything the asker marks urgent with a reason, the manager's own questions and its questions over
// rooms (the manager is the owner's own line), and "Trust and start".
// A held button is on file at once (the asker is told when it will come up); until its list time the
// page shows it as a quiet clock over the room, answerable early.

import type { Ask } from './asks.ts';

export const LIST_HOURS = [9, 17] as const;
export const INSTANT_WHY = new Set(['post', 'password', 'camera']);

// Whether this button waits for a list time (`isManager`: the folder is the manager's own).
export function waitsForList(a: Ask, isManager: (folder: string) => boolean): boolean {
  if (a.trust || a.askedFor || a.urgent || !a.why) return false;
  if (INSTANT_WHY.has(a.why.toLowerCase())) return false;
  return !isManager(a.folder);
}

// The first list time strictly after `t` (local time: 09:00 or 17:00).
export function listTimeAfter(t: number): number {
  const d = new Date(t);
  for (let day = 0; day < 2; day++) {
    for (const h of LIST_HOURS) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, h, 0, 0, 0).getTime();
      if (at > t) return at;
    }
  }
  throw new Error('unreachable');
}

// Whether the owner sees this button as due now (not as a held clock).
export const shownNow = (a: Ask, now: number, isManager: (folder: string) => boolean): boolean => !waitsForList(a, isManager) || now >= listTimeAfter(a.since ?? a.createdAt);

// The buttons due now.
export const visibleAsks = (asks: Ask[], now: number, isManager: (folder: string) => boolean): Ask[] => asks.filter((a) => shownNow(a, now, isManager));

const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// What the asker is told when its button waits.
export const heldLine = (createdAt: number): string =>
  `This button waits for the owner's ${hhmm(listTimeAfter(createdAt))} list (non-urgent buttons come up together at 09:00 and 17:00; until then the owner sees a quiet clock over your head and may answer early). Carry on with other work meanwhile; the answer will arrive in this chat. If it truly can't wait, ask again with --urgent "<why it can't wait>".`;
