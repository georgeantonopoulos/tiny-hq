// The office's side of button-only posts: the owner's Approve on a --why post button writes
// a one-time pass for that exact text, for the room that asked. hooks/post-approvals.mjs reads and
// uses the passes (same file, same format, same lock); it's plain JS because hooks run it, so the
// office writes the file itself here.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from './file-lock.ts';

export const PASS_TTL_MS = 2 * 60 * 60_000;
export const approvalsPath = (dataDir: string) => join(dataDir, 'post-approvals.json');

// The one file a post carries, as the owner saw it on their button: the guard lets only these bytes up.
export type PostMedia = { name: string; sha256: string; bytes: number };
type Pass = { text: string; from: string; alsoFrom?: string; target?: string; media?: PostMedia; act?: 'delete'; at: number; expires: number; usedAt?: number; session?: string };

const withLock = (path: string, fn: () => void) => withFileLock(path, fn, 'post approvals are busy');

// Where a post goes: the same reading as hooks/post-approvals.mjs normTarget (a test keeps them alike).
export function normTarget(t: string | undefined): string {
  const s = String(t ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:pull|pulls|issues)\/(\d+))?(?:[/?#].*)?$/i);
  if (!m) m = s.match(/^([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(?:#(\d+))?$/);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase() + (m[3] ? `#${Number(m[3])}` : '');
  // A public deploy of one project (deploys are button-only, like posts).
  const d = /^deploy:([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (d) return `deploy:${d[1]!.toLowerCase()}`;
  // A device on the owner's Mac: one camera or microphone capture they approved.
  if (/^device:camera$/i.test(s)) return 'device:camera';
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    u.searchParams.sort();
    return `https://${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return '';
  }
}

// `alsoFrom`: the folder the asker ran from when it isn't inside the room (a worktree or clone kept
// elsewhere); the one pass works in either place, and using it in one uses it up for both.
export function grantPass(path: string, text: string, from: string, now = Date.now(), target = '', alsoFrom = '', media?: PostMedia): void {
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
    if (keep.some((p) => !p.usedAt && p.expires > now && p.text === text && p.from === from && (p.target ?? '') === where && (p.media?.sha256 ?? '') === (media?.sha256 ?? ''))) return;
    const tmp = `${path}.${process.pid}.tmp`;
    // A --delete button: its fixed sentence makes the pass a few clicks on that one page, never typing.
    const act = where.startsWith('https://') && text === `delete the post at ${where}` && !media ? { act: 'delete' as const } : {};
    writeFileSync(tmp, JSON.stringify([...keep, { text, from, ...(alsoFrom && alsoFrom !== from ? { alsoFrom } : {}), target: where, ...(media ? { media } : {}), ...act, at: now, expires: now + PASS_TTL_MS }], null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  });
}
