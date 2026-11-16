// On-call rooms: a room that works only when someone asks it something (a life-admin room, say,
// that shouldn't run tasks by itself and spend credits). The office never reaches it on its own:
// no goal steps, hourly checks, GitHub news, expired-button notices, /compact, and it is never
// picked for a coffee break (its notes may be the owner's mail and diary).
// What still gets through: the owner's own clicks and typing, and the nudge for a job the owner gave it.
//
// The list is "onCallProjects" in ~/.tiny-hq/config.json. One declaration, checked in two
// places only: typeInto in src/daemon/main.ts (every line the office types into a session) and the
// room lists the office picks from by itself (goals, coffee). test/on-call.test.ts fails if a new
// automatic sender skips it. manager/delegate also refuses to start one (src/cli/on-call.ts).

import { realpathSync } from 'node:fs';

// The Mac's disk ignores letter case and plain realpathSync keeps whatever case it was given, so
// `~/dev/Life-Admin` would not match `~/Dev/life-admin`. The native call returns the folder's real
// spelling; comparing lower-cased covers paths that no longer exist.
const real = (p: string): string => {
  try {
    return realpathSync.native(p).toLowerCase();
  } catch {
    return p.replace(/\/+$/, '').toLowerCase();
  }
};

/** Is this folder an on-call room, or anywhere inside one (a worktree, a sub folder)? */
export function isOnCall(folder: string | undefined, onCall: readonly string[]): boolean {
  if (!folder) return false;
  const f = real(folder);
  return onCall.some((p) => {
    const r = real(p);
    return f === r || f.startsWith(`${r}/`);
  });
}

/** Who a typed line comes from: the owner (their click, mic or typing), the nudge for a job the owner gave, or the office by itself. */
export type Sender = 'owner' | 'job' | 'office';

/** May the office type this line into a session working in `folder`? */
export const mayReach = (folder: string | undefined, from: Sender, onCall: readonly string[]): boolean => from !== 'office' || !isOnCall(folder, onCall);
