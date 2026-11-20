// The evening note: one calm page on the owner's desk each evening that collects everything that
// didn't need them at the time, instead of a button or a bubble for each: choices rooms made
// themselves, jobs finished, merges rooms made, buttons that came down unanswered, goal steps.
// Rooms add a line with `manager/evening add`; the office adds its own (finished jobs, expired
// buttons) and files the page at EVENING_AT with no tokens spent. Nothing to say: no page.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Job } from './jobs.ts';
import type { Ask } from './asks.ts';

export const KINDS = { decision: 'Decisions rooms made', merge: 'Merged after clean tests and review', step: 'Goal steps', expired: 'Buttons that came down unanswered (taken as "not now")', github: 'New on GitHub from other people', note: 'Other news' } as const;
export type Kind = keyof typeof KINDS;
export interface Entry {
  at: number;
  kind: Kind;
  folder: string; // the room's folder (shown by the room's name)
  text: string;
}

export const EVENING_AT = 19; // local hour the note is filed
export const ASK_TTL_MS = 2 * 86_400_000; // a button unanswered this long comes down as "not now"
export const EXPIRED_HOLD_MS = 7 * 86_400_000; // a job whose button expired rests this long before carrying on

export const eveningPath = (notesDir: string) => join(notesDir, 'evening.jsonl');
const statePath = (notesDir: string) => join(notesDir, 'evening-state.json');

const clean = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function addEntry(path: string, e: Omit<Entry, 'at'> & { at?: number }): Entry | undefined {
  const text = clean(e.text, 600);
  if (!text || !(e.kind in KINDS)) return undefined;
  const row: Entry = { at: e.at ?? Date.now(), kind: e.kind, folder: e.folder, text };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n');
  return row;
}

export function loadEntries(path: string): Entry[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          const o = l ? (JSON.parse(l) as Entry) : undefined;
          return o && typeof o.at === 'number' && o.kind in KINDS && typeof o.text === 'string' ? [o] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function lastFiled(notesDir: string): number {
  try {
    const n = (JSON.parse(readFileSync(statePath(notesDir), 'utf8')) as { lastAt?: number }).lastAt;
    return typeof n === 'number' ? n : 0;
  } catch {
    return 0;
  }
}
export function markFiled(notesDir: string, at: number): void {
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(statePath(notesDir), JSON.stringify({ lastAt: at }));
}

// Today's filing time, if it has passed and the note isn't filed yet.
export function eveningDue(lastAt: number, now: Date): number | undefined {
  const at = new Date(now);
  at.setHours(EVENING_AT, 0, 0, 0);
  return now.getTime() >= at.getTime() && lastAt < at.getTime() ? at.getTime() : undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const COUNT_WORD: Record<Kind, string> = { decision: 'decision', merge: 'merge', step: 'goal step', expired: 'button', github: 'GitHub item', note: 'note' };

// The page itself: everything since the last note, grouped. undefined when there's nothing.
// `entriesSince` can reach further back than `since` (the first note takes every entry queued).
export function eveningNote(entries: Entry[], jobs: Job[], since: number, now: number, roomName: (folder: string) => string, entriesSince = since): { title: string; markdown: string } | undefined {
  const fresh = entries.filter((e) => e.at > entriesSince && e.at <= now);
  const done = jobs.filter((j) => j.status === 'done' && j.updatedAt > since && j.updatedAt <= now);
  if (!fresh.length && !done.length) return undefined;
  const day = new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const counts: string[] = [];
  const parts: string[] = [`# Evening note, ${day}`, '', 'Everything that did not need you today. Nothing here is waiting on you; the questions that are stay on their buttons.'];
  if (done.length) {
    counts.push(`${plural(done.length, 'job')} done`);
    parts.push('', '## Jobs finished', '', ...done.map((j) => `- **${roomName(j.room)}**: ${clean(j.title, 200)}`));
  }
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const rows = fresh.filter((e) => e.kind === kind);
    if (!rows.length) continue;
    counts.push(plural(rows.length, COUNT_WORD[kind]) + (kind === 'expired' ? ' expired' : ''));
    parts.push('', `## ${KINDS[kind]}`, '', ...rows.map((e) => `- **${roomName(e.folder)}**: ${e.text}`));
  }
  return { title: `Evening note, ${day}: ${counts.join(', ')}`, markdown: parts.join('\n') + '\n' };
}

// Buttons the owner left unanswered for ASK_TTL_MS come down as "not now". A "Trust and start"
// button is kept (its room can't start without it, and nothing nags meanwhile).
export function expiredAsks(asks: Ask[], now: number): { left: Ask[]; expired: Ask[] } {
  const old = (a: Ask) => !a.trust && now - a.createdAt >= ASK_TTL_MS;
  return { left: asks.filter((a) => !old(a)), expired: asks.filter(old) };
}

// A job whose button came down rests for a week (no nudges, no 15-minute checks, no new button),
// then carries on by itself, like any job held for an outside event.
export function restJobs(jobs: Job[], expired: Ask[], now: number): Job[] {
  const ids = new Set(expired.flatMap((a) => [a.job, a.forJob].filter((x): x is string => !!x)));
  return jobs.map((j) => {
    if (!ids.has(j.id) || j.status !== 'waiting') return j;
    const { waitingFor, ...rest } = j;
    return { ...rest, status: 'active' as const, holdFor: `the owner's "not now" (no answer in 2 days to: ${clean(waitingFor ?? j.title, 200)})`, holdUntil: now + EXPIRED_HOLD_MS, updatedAt: now };
  });
}

// What the asker reads when its button came down.
export function expiredLine(ask: Ask): string {
  return `[Office: your question "${ask.question}" was up for 2 days with no answer from the owner, so the office took it down: take it as "not now".${ask.job ? ` Job ${ask.job} rests for a week, then carries on.` : ''} Don't put it up again unless something has changed; carry on with whatever you can do without it, and make any choice that's yours yourself (it goes in the evening note). No reply needed.]`;
}

// Files today's note if it's due. Marked filed only once the page is on the desk (or there was
// nothing to say), so a failed write is tried again next tick with the same entries instead of
// losing the day.
export function fileEvening(notesDir: string, entriesPath: string, jobs: Job[], now: number, roomName: (folder: string) => string, file: (title: string, markdown: string) => void): string | undefined {
  const due = eveningDue(lastFiled(notesDir), new Date(now));
  if (due === undefined) return undefined;
  // The first note (nothing filed yet) carries every entry queued, even if the first 19:00 was
  // missed (asleep, say); finished jobs still go back one day only, not to the beginning.
  const last = lastFiled(notesDir);
  const note = eveningNote(loadEntries(entriesPath), jobs, last || due - 86_400_000, now, roomName, last || 0);
  if (!note) {
    markFiled(notesDir, now);
    return 'evening note: nothing to say today, no page';
  }
  try {
    file(note.title, note.markdown);
  } catch (e) {
    return `evening note: could not file it, trying again next tick (${(e as Error).message})`;
  }
  markFiled(notesDir, now);
  return `evening note: on the owner's desk (${note.title})`;
}
