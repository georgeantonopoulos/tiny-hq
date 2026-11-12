// Approved posts. A public post runs only when the owner has
// approved that exact text on their button: their Approve writes a one-time pass here, good for 2 hours,
// for the room that asked; the public-post guard lets through only a post whose text matches an
// unused pass, from that room, and uses it up. Shared by hooks/public-post-guard.mjs and the office
// (src/team/posts.ts writes the same file). Plain JS: hooks run it.
//
// What this protects against is a post slipping out by accident (an approved prompt, a reflex). A
// room set on forging a pass could write this file itself: the guard refuses any shell command that
// names it, but a hook can't be airtight against a determined session on the owner's own account.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PASS_TTL_MS = 2 * 60 * 60_000;
export const CLICK_WINDOW_MS = 10 * 60_000; // after typing approved text on a site, one Post click in that tab

export const approvalsPath = (dataDir = process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq')) => join(dataDir, 'post-approvals.json');

// The same text whatever the spacing, line endings or quoting the tool added.
export const sameText = (a, b) => norm(a) === norm(b) && norm(a) !== '';
const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

// Where a post goes: "owner/repo#N" for a pull request
// or issue, "owner/repo" for something new in a repo (a new issue), or a web page "host/path" for a
// post on another site. GitHub owners have no dots, so "example.com/forum" is never read as a repo.
// '' when it can't be read.
export function normTarget(t) {
  const s = String(t ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:pull|pulls|issues)\/(\d+))?(?:[/?#].*)?$/i);
  if (!m) m = s.match(/^([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?(?:#(\d+))?$/);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase() + (m[3] ? `#${Number(m[3])}` : '');
  // A public deploy of one project (deploys are button-only, like posts).
  const d = /^deploy:([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (d) return `deploy:${d[1].toLowerCase()}`;
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    u.searchParams.sort();
    return `https://${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return '';
  }
}
const isRepoTarget = (t) => /^[a-z0-9-]+\/[\w.-]+(#\d+)?$/.test(t) || t.startsWith('deploy:');
// A pass's target against where the post actually goes: a PR, issue or repo exactly; a site page, or
// a page under it, with the same query (a thread's ?id=1 is not ?id=2). A pass with no target (from before targets existed) goes nowhere.
export function sameTarget(pass, actual) {
  const p = normTarget(pass);
  const a = normTarget(actual);
  if (!p || !a) return false;
  if (isRepoTarget(p) || isRepoTarget(a)) return p === a;
  const [pp, pq = ''] = p.split('?');
  const [ap, aq = ''] = a.split('?');
  if (pq !== aq) return false;
  return ap === pp || ap.startsWith(`${pp}/`);
}

export function loadPasses(path = approvalsPath()) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.text === 'string' && typeof p.expires === 'number') : [];
  } catch {
    return [];
  }
}

function save(path, list) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// One reader-writer at a time (Claude Code runs tool calls in parallel, so two hooks could both find
// the same unused pass). A lock left behind for over 10 s by a crash is taken over.
function locked(path, fn) {
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
      if (stale) {
        try { rmSync(lock, { recursive: true, force: true }); } catch { /* someone else took it */ }
        continue;
      }
      if (Date.now() > until) throw new Error('post approvals are busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    writeFileSync(`${lock}/at`, String(Date.now()));
    return fn();
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
  }
}

// Inside the room that asked (or one of its worktrees)?
const inRoom = (cwd, folder) => !folder || (typeof cwd === 'string' && (cwd === folder || cwd.startsWith(`${folder}/`)));

// the owner's Approve: one pass for this exact text, at this target, for the room that asked.
export function grantPass(text, from, now = Date.now(), path = approvalsPath(), target = '') {
  locked(path, () => {
    const keep = loadPasses(path).filter((p) => p.expires > now - 24 * 60 * 60_000).slice(-50);
    save(path, [...keep, { text: String(text), from: String(from ?? ''), target: normTarget(target), at: now, expires: now + PASS_TTL_MS }]);
  });
}

// Uses up the first unused, unexpired pass for this room whose text and target match. `where` notes a
// browser tab and site, so that tab's Post click may follow. True if there was one.
export function usePass(text, session, now = Date.now(), path = approvalsPath(), cwd, where, target) {
  return locked(path, () => {
    const list = loadPasses(path);
    const i = list.findIndex((p) => !p.usedAt && p.expires > now && inRoom(cwd, p.from) && sameText(p.text, text) && sameTarget(p.target, target));
    if (i < 0) return false;
    list[i] = { ...list[i], usedAt: now, session: String(session ?? ''), ...(where ? { tab: String(where.tab), site: String(where.site) } : {}) };
    save(path, list);
    return true;
  });
}

// A change the owner approved for one project in their own words ("create a Vercel share link for
// <project>"), used up by a host API call the guard can't put in fixed words: the first
// unused pass for that target from this room, whatever its text. Never used for a deploy itself,
// which still needs "deploy <project> publicly".
export function useTargetPass(session, now = Date.now(), path = approvalsPath(), cwd, target) {
  return locked(path, () => {
    const list = loadPasses(path);
    const i = list.findIndex((p) => !p.usedAt && p.expires > now && inRoom(cwd, p.from) && sameTarget(p.target, target));
    if (i < 0) return false;
    list[i] = { ...list[i], usedAt: now, session: String(session ?? '') };
    save(path, list);
    return true;
  });
}

// The Post click after typing approved text: only in the same session, tab and site, within a few
// minutes, and only once.
export function useClick(session, tab, site, now = Date.now(), path = approvalsPath()) {
  return locked(path, () => {
    const list = loadPasses(path);
    const i = list.findIndex((p) => p.usedAt && !p.clicked && p.session === String(session ?? '') && p.tab === String(tab) && p.site === String(site) && now - p.usedAt < CLICK_WINDOW_MS);
    if (i < 0) return false;
    list[i] = { ...list[i], clicked: now };
    save(path, list);
    return true;
  });
}
