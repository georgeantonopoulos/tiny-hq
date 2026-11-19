// One reader-writer at a time for a small JSON file that several processes change (the office,
// the manager/ask and manager/job commands, hooks). Without it two read-change-writes at once lose
// one of the changes. The lock is a folder next to the file (`<file>.lock`), the same one
// hooks/post-approvals.mjs takes, so the plain-JS hooks and this agree. A lock left behind for
// over 10 s by a crash is taken over; waiting more than 3 s for a live one throws.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STALE_MS = 10_000;
export const WAIT_MS = 3000;

export function withFileLock<T>(path: string, fn: () => T, busy = `${path} is busy`): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const until = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let stale = false;
      // Its age: the time written inside it, or (just taken, nothing written yet) the folder's own
      // age, so a lock another process has only this moment taken is never mistaken for a stale one.
      try {
        const at = Number(readFileSync(`${lock}/at`, 'utf8'));
        if (!at) throw new Error('time not written yet'); // fall back to the folder's age
        stale = Date.now() - at > STALE_MS;
      } catch {
        try {
          stale = Date.now() - statSync(lock).mtimeMs > STALE_MS;
        } catch {
          stale = false; // gone in between: try again
        }
      }
      if (stale) {
        try {
          rmSync(lock, { recursive: true, force: true });
        } catch {
          /* someone else took it over */
        }
        continue;
      }
      if (Date.now() > until) throw new Error(busy);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    writeFileSync(`${lock}/at`, String(Date.now()));
    return fn();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
}
