// Goal steps: rooms with a goal keep working toward it on their own while the
// allowance has room (src/team/budget.ts). A goal is the owner's standing ask for that
// room, so a step needs no button; it stays private and undoable (a branch, tests,
// drafts) and stops at the same lines as every job: no email, nothing public, no
// release, no payment without the owner. A PR it opens it merges itself once tests and an
// independent review pass (MERGE_RULE).
//
// The log (~/.tiny-hq/manager/goal-steps.jsonl) is one line per step started,
// read by the picker (who's had a turn lately) and the scorecard.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MERGE_RULE } from './only-owner.ts';

export interface Step {
  room: string; // the room's project folder
  at: number;
  how: 'typed' | 'started';
}

// A room gets at most one step every 3 hours, and the office starts at most one
// step every 10 minutes, so a big allowance fills up gradually.
export const ROOM_GAP_MS = 3 * 3_600_000;
export const START_GAP_MS = 10 * 60_000;

export function stepsPath(managerNotesDir: string): string {
  return join(managerNotesDir, 'goal-steps.jsonl');
}

export function loadSteps(path: string, since = 0): Step[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l) as Step;
        } catch {
          return undefined;
        }
      })
      .filter((s): s is Step => !!s && typeof s.room === 'string' && typeof s.at === 'number' && s.at >= since);
  } catch {
    return [];
  }
}

export function logStep(path: string, step: Step): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify(step) + '\n', { mode: 0o600 });
}

export interface Candidate {
  room: string; // project folder
  goal: string;
  hasJob: boolean; // an open job (active, held or waiting): that's already its work
  hasAsk: boolean; // a question is up over its head
  busy: boolean; // a session there is mid-reply, blocked, or the owner is watching it
  since?: number; // when the owner set this goal
}

const lastStep = (steps: Step[], room: string) => steps.filter((s) => s.room === room).reduce((m, s) => Math.max(m, s.at), 0);
// A goal that hasn't had a step since the owner set it. Without this, goals set in the morning
// could sit untouched all day because the one free place was always taken by a busy room.
export const isNew = (c: Candidate, steps: Step[]) => lastStep(steps, c.room) < (c.since ?? 0);

// The room to give the next step to, or none. New goals first, then longest-waiting.
// `free`: places left under the allowance once busy rooms are counted. With none left, a new
// goal still gets its first step (the allowance itself must have room: the caller checks).
export function pickRoom(cands: Candidate[], steps: Step[], now: number, free = 1): Candidate | undefined {
  const lastStart = steps.reduce((m, s) => Math.max(m, s.at), 0);
  if (now - lastStart < START_GAP_MS) return undefined;
  return cands
    .filter((c) => c.goal && !c.hasJob && !c.hasAsk && !c.busy && now - lastStep(steps, c.room) >= ROOM_GAP_MS && (free >= 1 || isNew(c, steps)))
    .sort((a, b) => Number(isNew(b, steps)) - Number(isNew(a, steps)) || lastStep(steps, a.room) - lastStep(steps, b.room))[0];
}

// New goals still without a first step this long after the owner set them are reported to the manager once.
export const FIRST_STEP_LATE_MS = 4 * 3_600_000;
export function lateFirstSteps(cands: Candidate[], steps: Step[], now: number): Candidate[] {
  return cands.filter((c) => c.goal && c.since && now - c.since >= FIRST_STEP_LATE_MS && isNew(c, steps));
}

// Why a room hasn't had its first step, in plain words for the manager.
export function whyNoStep(c: Candidate, allowance: string, onCall: boolean): string {
  if (onCall) return 'it is an on-call room, so the office never starts work there by itself';
  if (c.hasJob) return 'it has an open job, which counts as its work';
  if (c.hasAsk) return 'a question is up over its head, waiting for the owner';
  if (c.busy) return 'its session has been busy every time the office looked';
  return `the Claude allowance had no room (${allowance})`;
}

// What the room is told. One line: Enter sends it.
export function stepLine(goal: string, why: string, ask: string): string {
  return (
    `[Office: goal step] The owner's goal for this room: "${goal}". There's spare Claude allowance right now (${why}), so take the next useful step toward it on your own; the owner set the goal, so no need to ask them to start. ` +
    `First check your project notes and git so you don't redo or contradict earlier work, then pick the one step that helps the goal most and do it, in a worktree on its own branch. ` +
    `Yours to do: read, investigate, test, fix, commit to that branch, push it and open a PR. Not without the owner's yes: releases or store submissions, sending any email, anything on a public site (posts, comments, issues, PR comments, reviews), paying, deleting data. ${MERGE_RULE} ` +
    `If the next step needs their yes for money, public text or something that can't be undone, or is a choice that changes what they get (--why choice with --choices, your pick first), ask with ${ask} (--why and --tried) and stop; small, reversible choices are yours. Keep it to about an hour, then one line for the owner's evening note (no message to the manager): ${ask.replace(/ask$/, 'evening')} add "<what you did, what's next>" --kind step.`
  ).replace(/\s+/g, ' ');
}
