// Jobs: the things the owner asked for that aren't done yet, one per room, in
// ~/.tiny-hq/manager/jobs.json. Each has a plain "done when" line. While a
// job is open, the office keeps it moving: when the room's session has gone
// quiet without finishing, the office types a nudge into it (never while it's
// working, blocked on a prompt, or the owner is looking at it). If nudges stop
// helping, it tells the manager. A job only stops being nudged when it's done, or
// when the room says it's waiting on the owner and what for.
//
// The manager adds jobs; the room (or the manager) marks them waiting or done, with manager/job.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { localDay } from './schedule.ts';

export type JobStatus = 'active' | 'waiting' | 'done';

export interface Job {
  id: string; // short slug, e.g. "pebble-testing"
  room: string; // the project folder the work happens in
  title: string; // what the owner reads
  done: string; // what "finished" looks like, checkable
  status: JobStatus;
  waitingFor?: string; // status 'waiting': the one thing the owner must do
  createdAt: number;
  updatedAt: number;
  lastNudge?: number; // ms: last time the office nudged the room (or told the manager)
  nudgeDay?: string; // YYYY-MM-DD the count below is for
  nudgesToday?: number;
  stuckDay?: string; // the manager was told it's stuck on this day (once a day)
  // Waiting for something outside the office (a reply, a review, a test day), not for the owner:
  // no nudges until `holdUntil`, then the job simply carries on. No button for the owner.
  holdFor?: string;
  holdUntil?: number; // ms
}

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const clean = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function validJob(j: unknown): Job | undefined {
  if (!j || typeof j !== 'object') return undefined;
  const o = j as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  if (!ID.test(str('id')) || !str('room').startsWith('/') || !clean(str('title'), 120) || !clean(str('done'), 400)) return undefined;
  const status: JobStatus = o.status === 'waiting' || o.status === 'done' ? o.status : 'active';
  const num = (k: string) => (typeof o[k] === 'number' && (o[k] as number) > 0 ? (o[k] as number) : undefined);
  const job: Job = {
    id: str('id'),
    room: str('room'),
    title: clean(str('title'), 120),
    done: clean(str('done'), 400),
    status,
    createdAt: num('createdAt') ?? Date.now(),
    updatedAt: num('updatedAt') ?? Date.now(),
  };
  if (status === 'waiting' && str('waitingFor')) job.waitingFor = clean(str('waitingFor'), 300);
  if (num('lastNudge')) job.lastNudge = num('lastNudge');
  if (str('nudgeDay')) job.nudgeDay = str('nudgeDay');
  if (num('nudgesToday')) job.nudgesToday = num('nudgesToday');
  if (str('stuckDay')) job.stuckDay = str('stuckDay');
  if (status === 'active' && str('holdFor') && num('holdUntil')) {
    job.holdFor = clean(str('holdFor'), 300);
    job.holdUntil = num('holdUntil');
  }
  return job;
}

export function loadJobs(path: string): Job[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { jobs?: unknown };
    const seen = new Set<string>();
    return (Array.isArray(raw.jobs) ? raw.jobs : []).map(validJob).filter((j): j is Job => !!j && !seen.has(j.id) && !!seen.add(j.id)).slice(0, 50);
  } catch {
    return [];
  }
}

export function saveJobs(path: string, jobs: Job[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// Each job has a brief: everything the room needs to do a good job without
// guessing, in ~/.tiny-hq/manager/jobs/<id>.md. The manager fills it in before
// handing the job over and adds to it as things change; the room reads it
// first (every new session does), and adds progress notes to it.
export function briefPath(managerNotesDir: string, id: string): string {
  return `${managerNotesDir}/jobs/${id}.md`;
}

export const BRIEF_SECTIONS = ["The owner's words", 'Goal', 'What we know', 'Already done', 'Rules and limits', 'Open questions'] as const;

export function briefTemplate(job: Pick<Job, 'id' | 'title' | 'done' | 'room'>): string {
  return [
    `# Job ${job.id}: ${job.title}`,
    '',
    `Room folder: ${job.room}`,
    `Done when: ${job.done}`,
    '',
    "## The owner's words",
    '<!-- What the owner actually said, quoted word for word, with when and where. Not your summary. -->',
    '',
    '## Goal',
    '<!-- Why they want it and what a great result looks like to them. -->',
    '',
    '## What we know',
    '<!-- Every fact the room needs, with its source: email threads (subject, date, the key lines quoted), links and guides to read in full, file paths, project notes by name, dates and deadlines. -->',
    '',
    '## Already done',
    '<!-- What earlier sessions or rooms already did, so nothing is redone or contradicted (with dates and notes). -->',
    '',
    '## Rules and limits',
    '- No email (or message to a person outside the office) is sent without the owner: draft only.',
    "- Nothing goes on a public site (post, comment, reply, review, DM, upload) without the owner's yes for that exact text: put the text to them with manager/ask \"<what and where>\" --why post --tried \"<...>\" --text \"<the exact text>\" (posts are button-only: only their Approve on that exact text lets it through, once).",
    "- Every other step of this job is the room's to do, Chrome consoles and sign-ins their Chrome already has included. A broken office tool goes to the manager as an office fault. Need a yes from the owner: manager/ask --why <reason> --tried \"<what you tried>\".",
    '',
    '## Open questions',
    '',
    '## Progress',
    '<!-- The room adds a dated line per step: ~/.tiny-hq/app/manager/job note <id> "<what happened>" -->',
    '',
  ].join('\n');
}

// Sections the manager still hasn't filled in (only the comment placeholder under the heading).
export function emptySections(brief: string): string[] {
  const bodies = new Map<string, string>();
  let current = '';
  for (const line of brief.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const h = /^## (.+)$/.exec(line);
    if (h) current = h[1]!.trim();
    else if (current) bodies.set(current, `${bodies.get(current) ?? ''}${line}\n`);
  }
  return BRIEF_SECTIONS.filter((name) => name !== 'Open questions' && !(bodies.get(name) ?? '').trim());
}

export function jobsPath(managerNotesDir: string): string {
  return `${managerNotesDir}/jobs.json`;
}

// How long a room may sit quiet before a nudge, the gap between nudges, and how
// many a day before the manager hears it's stuck.
export const QUIET_MS = 5 * 60_000;
export const GAP_MS = 20 * 60_000;
export const MAX_NUDGES_PER_DAY = 6;

export interface RoomNow {
  status?: string; // busy | idle
  state?: string; // working | blocked | done
  lastActive: number; // ms: the session's last real message
  viewed: boolean; // the owner has its terminal open
}

export type Decision = 'none' | 'nudge' | 'no-session' | 'stuck' | 'check';

// A job waiting on the owner is checked every so often: has they done it yet (sent
// the email, clicked the thing)? Nobody else tells the room when they do.
export const CHECK_MS = 15 * 60_000;
export const MAX_CHECKS_PER_DAY = 16;

export const MAX_HOLD_MS = 14 * 86_400_000;

// Is the job held (waiting on an outside event) at this moment?
export const isHeld = (job: Job, now: number): boolean => job.status === 'active' && !!job.holdUntil && now < job.holdUntil;

// "03:00" (next time it's 03:00), "2026-11-08 03:00" or "2026-11-08T03:00" (local time),
// "in 3h" / "in 45m" / "in 2d". Returns ms, or undefined if it can't be read or isn't in the next 14 days.
export function parseUntil(text: string, now: number): number | undefined {
  const t = text.trim().toLowerCase();
  let at: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^in\s+(\d+(?:\.\d+)?)\s*(m|min|h|d)$/.exec(t))) at = now + Number(m[1]) * ({ m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!] as number);
  else if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    at = d.getTime();
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(t))) at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return at !== undefined && Number.isFinite(at) && at > now && at <= now + MAX_HOLD_MS ? at : undefined;
}

// What the office should do about one job right now.
// roomAsking: the room's own question that this waiting job rides on is still open over its head.
export function decide(job: Job, room: RoomNow | undefined, now: number, roomAsking = false): Decision {
  if (job.status === 'done') return 'none';
  if (isHeld(job, now)) return 'none'; // waiting on an outside event: no nudges, no "stuck", until the hold runs out
  if (job.status === 'waiting') {
    // The owner's answer on that button goes straight to the room and wakes the job: nothing to check.
    // (Otherwise the manager answers "(quiet)" to this check again and again.)
    if (roomAsking) return 'none';
    if (now - Math.max(job.lastNudge ?? 0, job.updatedAt) < CHECK_MS) return 'none';
    if (room && (room.status === 'busy' || room.state === 'blocked' || room.viewed)) return 'none';
    const day = localDay(new Date(now));
    return (job.nudgeDay === day ? (job.nudgesToday ?? 0) : 0) >= MAX_CHECKS_PER_DAY ? 'none' : 'check';
  }
  if (now - (job.lastNudge ?? 0) < GAP_MS) return 'none';
  if (!room) return 'no-session';
  if (room.status === 'busy' || room.state === 'blocked' || room.viewed) return 'none';
  if (now - room.lastActive < QUIET_MS) return 'none';
  const today = localDay(new Date(now));
  const count = job.nudgeDay === today ? (job.nudgesToday ?? 0) : 0;
  if (count >= MAX_NUDGES_PER_DAY) return job.stuckDay === today ? 'none' : 'stuck';
  return 'nudge';
}

// Record that the office acted on a job.
export function nudged(job: Job, d: Decision, now: number): Job {
  const today = localDay(new Date(now));
  const count = job.nudgeDay === today ? (job.nudgesToday ?? 0) : 0;
  return {
    ...job,
    lastNudge: now,
    nudgeDay: today,
    nudgesToday: d === 'nudge' || d === 'check' ? count + 1 : count,
    ...(d === 'stuck' ? { stuckDay: today } : {}),
  };
}

// The line typed into the room's session. One line: Enter sends it.
export function nudgeLine(job: Job, cli: string, brief = `~/.tiny-hq/manager/jobs/${job.id}.md`): string {
  return clean(
    `[Office: job "${job.title}" is not done yet] Done means: ${job.done}. ` +
      `First read the job brief, ${brief}, and add a line to its Progress as you go (${cli} note ${job.id} "<what happened>"). ` +
      `Do the next step yourself now, and keep going until it's done: you have the owner's logged-in Chrome for websites and consoles (store consoles, dashboards), plus the terminal and your tools. ` +
      `The only things you must never do: send an email (or a message to a person outside the office), or put anything on a public site (post, comment, reply, review, DM): draft it and get the owner's yes for that exact text with manager/ask (--why send, or --why post with --text "<the exact text>": posts are button-only). ` +
      `Don't hand the owner a step you can do yourself: a sign-in their Chrome already has, an upload, a form or a console button is yours; a broken tool or connector goes to the manager as an office fault. ` +
      `Only if it's an email to send, a public post, a payment, a choice that's theirs, or a password or 2-factor code you can't get past, run: ${cli} wait ${job.id} "<the one thing the owner must do>" --why <send|post|pay|choice|permission|password> --tried "<what you already tried>". ` +
      `When it's done, run: ${cli} done ${job.id} and report to the manager.`,
    2000,
  );
}

// The line for a job waiting on the owner: check whether they have done it.
export function checkLine(job: Job, cli: string, brief = `~/.tiny-hq/manager/jobs/${job.id}.md`): string {
  return clean(
    `[Office: job "${job.title}" (${job.id}) is waiting on the owner: ${job.waitingFor ?? 'not said'}] Check now whether they have done it: for an email, look in their sent mail for it (if an email connector is set up) (and any reply); for a website step, look at the page. ` +
      `If they have: run ${cli} go ${job.id}, add a line to the brief's Progress (${cli} note ${job.id} "<what you found>"), tell the manager in one line, and carry on with the next step (brief: ${brief}). ` +
      `If they haven't: change nothing, tell no one, and reply with exactly (quiet) and nothing else.`,
    2000,
  );
}

const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function describeJobs(jobs: Job[], roomName: (path: string) => string, now = Date.now()): string {
  const open = jobs.filter((j) => j.status !== 'done');
  if (!open.length) return 'No open jobs.';
  return open
    .map((j) => `- ${j.id} · ${roomName(j.room)} · ${j.title} · ${j.status === 'waiting' ? `WAITING ON OWNER: ${j.waitingFor ?? 'not said'}` : isHeld(j, now) ? `HOLDING until ${when(j.holdUntil!)}: waiting for ${j.holdFor}; not nudged, resumes by itself` : `active${j.nudgesToday && j.nudgeDay === localDay(new Date()) ? `, nudged ${j.nudgesToday}× today` : ''}`}\n  done when: ${j.done}`)
    .join('\n');
}
