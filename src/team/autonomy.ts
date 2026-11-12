// Goal steps: rooms with a goal keep working toward it on their own while the
// allowance has room (src/team/budget.ts). A goal is the owner's standing ask for that
// room, so a step needs no button; it stays private and undoable (a branch, tests,
// drafts) and stops at the same lines as every job: no email, nothing public, no
// release, no payment, no merge to main without the owner.
//
// The log (~/.tiny-hq/manager/goal-steps.jsonl) is one line per step started,
// read by the picker (who's had a turn lately) and the scorecard.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
}

// The room to give the next step to, or none. Longest-waiting first.
export function pickRoom(cands: Candidate[], steps: Step[], now: number): Candidate | undefined {
  const lastStart = steps.reduce((m, s) => Math.max(m, s.at), 0);
  if (now - lastStart < START_GAP_MS) return undefined;
  const last = (room: string) => steps.filter((s) => s.room === room).reduce((m, s) => Math.max(m, s.at), 0);
  return cands
    .filter((c) => c.goal && !c.hasJob && !c.hasAsk && !c.busy && now - last(c.room) >= ROOM_GAP_MS)
    .sort((a, b) => last(a.room) - last(b.room))[0];
}

// What the room is told. One line: Enter sends it.
export function stepLine(goal: string, why: string, ask: string): string {
  return (
    `[Office: goal step] The owner's goal for this room: "${goal}". There's spare Claude allowance right now (${why}), so take the next useful step toward it on your own; the owner set the goal, so no need to ask them to start. ` +
    `First check your project notes and git so you don't redo or contradict earlier work, then pick the one step that helps the goal most and do it, in a worktree on its own branch. ` +
    `Yours to do: read, investigate, test, fix, commit to that branch and push the branch. Not without the owner's yes: merging to main/master, releases or store submissions, sending any email, anything on a public site (posts, comments, issues, PR comments, reviews), paying, deleting data. ` +
    `If the next step needs their yes, ask with ${ask} (--why and --tried) and stop. Keep it to about an hour, then one line to the manager by SendMessage: what you did, what's next.`
  ).replace(/\s+/g, ' ');
}
