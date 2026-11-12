// The office's side of button-only posts: the owner's Approve on a --why post button writes
// a one-time pass for that exact text, for the room that asked. hooks/post-approvals.mjs reads and
// uses the passes (same file, same format, same lock); it's plain JS because hooks run it, so the
// office writes the file itself here.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PASS_TTL_MS = 2 * 60 * 60_000;
export const approvalsPath = (dataDir: string) => join(dataDir, 'post-approvals.json');

type Pass = { text: string; from: string; target?: string; at: number; expires: number; usedAt?: number; session?: string };

function withLock(path: string, fn: () => void): void {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const until = Date.now() + 3000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let stale = false;
      // Its age: the time written inside it, or (just taken, time not written yet) the folder's own
      // age, so a lock another process has only this moment taken is never mistaken for a stale one.
      try {
        stale = Date.now() - Number(readFileSync(`${lock}/at`, 'utf8')) > 10_000;
      } catch {
        try {
          stale = Date.now() - statSync(lock).mtimeMs > 10_000;
        } catch {
          stale = false; // gone in between: try again
        }
      }
      if (stale) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > until) throw new Error('post approvals are busy');
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    writeFileSync(`${lock}/at`, String(Date.now()));
    fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Where a post goes: the same reading as hooks/post-approvals.mjs normTarget (a test keeps them alike).
export function normTarget(t: string | undefined): string {
  const s = String(t ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:pull|pulls|issues)\/(\d+))?(?:[/?#].*)?$/i);
  if (!m) m = s.match(/^([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(?:#(\d+))?$/);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase() + (m[3] ? `#${Number(m[3])}` : '');
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    u.searchParams.sort();
    return `https://${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return '';
  }
}

export function grantPass(path: string, text: string, from: string, now = Date.now(), target = ''): void {
  withLock(path, () => {
    let list: Pass[] = [];
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (Array.isArray(raw)) list = raw as Pass[];
    } catch {
      /* first pass */
    }
    const keep = list.filter((p) => p && typeof p.expires === 'number' && p.expires > now - 24 * 60 * 60_000).slice(-50);
    // One decision, one pass: an Approve delivered twice (a retry) doesn't make a second one.
    const where = normTarget(target);
    if (keep.some((p) => !p.usedAt && p.expires > now && p.text === text && p.from === from && (p.target ?? '') === where)) return;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...keep, { text, from, target: where, at: now, expires: now + PASS_TTL_MS }], null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  });
}
