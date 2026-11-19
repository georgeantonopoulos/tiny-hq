// Approved posts. A public post runs only when the owner has
// approved that exact text on their button: their Approve writes a one-time pass here, good for 2 hours,
// for the room that asked; the public-post guard lets through only a post whose text matches an
// unused pass, from that room, and uses it up. Shared by hooks/public-post-guard.mjs and the office
// (src/team/posts.ts writes the same file). Plain JS: hooks run it.
//
// What this protects against is a post slipping out by accident (an approved prompt, a reflex). A
// room set on forging a pass could write this file itself: the guard refuses any shell command that
// names it, but a hook can't be airtight against a determined session on the owner's own account.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const isRepoTarget = (t) => /^[a-z0-9-]+\/[\w.-]+(#\d+)?$/.test(t) || t.startsWith('deploy:') || t.startsWith('device:');
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

// Inside the room that asked (the project, or any of its worktrees)? A button put up from a
// worktree passes in the main checkout too, and the other way round: a room often asks from its
// worktree and runs the approved command from the project folder.
const roomOf = (p) => { const at = p.indexOf('/.claude/worktrees/'); return at < 0 ? p : p.slice(0, at); };
const inRoom = (cwd, folder) => {
  if (!folder) return true;
  if (typeof cwd !== 'string') return false;
  const room = roomOf(folder);
  return cwd === room || cwd.startsWith(`${room}/`);
};
// A pass also works where the asker ran from, when that's outside the room (a worktree or clone kept elsewhere).
const passHere = (cwd, p) => inRoom(cwd, p.from) || (typeof p.alsoFrom === 'string' && p.alsoFrom !== '' && inRoom(cwd, p.alsoFrom));

// the owner's Approve: one pass for this exact text, at this target, for the room that asked.
// `media`: the one file the owner saw on the button ({ name, sha256, bytes }), for a post that carries it.
export function grantPass(text, from, now = Date.now(), path = approvalsPath(), target = '', alsoFrom = '', media) {
  locked(path, () => {
    const keep = loadPasses(path).filter((p) => p.expires > now - 24 * 60 * 60_000).slice(-50);
    save(path, [...keep, { text: String(text), from: String(from ?? ''), ...(alsoFrom && alsoFrom !== from ? { alsoFrom: String(alsoFrom) } : {}), target: normTarget(target), ...(media ? { media } : {}), ...(!media && /^https:\/\//.test(normTarget(target)) && String(text) === actText(target) ? { act: 'delete' } : {}), at: now, expires: now + PASS_TTL_MS }]);
  });
}

// Uses up the first unused, unexpired pass for this room whose text and target match. `where` notes a
// browser tab and site, so that tab's Post click may follow. True if there was one.
// A pass the owner approved with a file attached is only for a post in a browser tab (where the file can
// go up with it): a gh or curl post can't carry it, so it never uses one (a post approved with its
// video must not go out as text alone).
// `submits`: the typing itself sends the post (Enter at the end, or the tool's submit): under a pass
// with a file, only once that file is up in this tab, like the click.
export function usePass(text, session, now = Date.now(), path = approvalsPath(), cwd, where, target, submits = false) {
  return locked(path, () => {
    const list = loadPasses(path);
    const fileUp = (p) => p.uploaded && p.uploadSession === String(session ?? '') && p.uploadTab === String(where?.tab);
    const fits = (p) => !p.usedAt && !p.act && p.expires > now && passHere(cwd, p) && sameText(p.text, text) && sameTarget(p.target, target) && (!p.media || (!!where && (!submits || fileUp(p))));
    // A pass whose file already went up in this very tab first, so the click that follows can post both.
    let i = where ? list.findIndex((p) => fits(p) && fileUp(p)) : -1;
    if (i < 0) i = list.findIndex(fits);
    if (i < 0) return false;
    list[i] = { ...list[i], usedAt: now, session: String(session ?? ''), ...(where ? { tab: String(where.tab), site: String(where.site) } : {}) };
    save(path, list);
    return true;
  });
}

// A change the owner approved for one project in their own words ("create a Vercel share link for
// <project>"), used up by a host API call the guard can't put in fixed words: the first
// unused pass for that target from this room, whatever its text. Never used for a deploy itself,
// which still needs "deploy <project> at <commit> publicly".
// `match`: an extra check on the pass (the camera guard binds a pass to the command the owner approved).
export function useTargetPass(session, now = Date.now(), path = approvalsPath(), cwd, target, match = () => true) {
  return locked(path, () => {
    const list = loadPasses(path);
    const i = list.findIndex((p) => !p.usedAt && !p.act && p.expires > now && passHere(cwd, p) && sameTarget(p.target, target) && match(p));
    if (i < 0) return false;
    list[i] = { ...list[i], usedAt: now, session: String(session ?? '') };
    save(path, list);
    return true;
  });
}

// The last approved deploy of each project: passes are pruned after
// a day, so the commits-going-out list on the next deploy button reads from here, kept for good.
export const baselinesPath = (dataDir = process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq')) => join(dataDir, 'deploy-baselines.json');
export function loadBaselines(path = baselinesPath()) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
export function recordDeploy(project, commit, now = Date.now(), path = baselinesPath()) {
  try {
    const all = loadBaselines(path);
    all[String(project)] = { commit: String(commit), at: now };
    save(path, all);
  } catch {
    /* the deploy already passed; a missing baseline only lengthens the next list */
  }
}

// The Post click after typing approved text: only in the same session, tab and site, within a few
// minutes, and only once.
// A pass approved with a file posts only once that file has gone up in the same tab, so the text
// never goes out alone under a pass approved with a video.
export function useClick(session, tab, site, now = Date.now(), path = approvalsPath()) {
  return locked(path, () => {
    const list = loadPasses(path);
    const i = list.findIndex((p) => p.usedAt && !p.clicked && p.session === String(session ?? '') && p.tab === String(tab) && p.site === String(site) && now - p.usedAt < CLICK_WINDOW_MS && (!p.media || (p.uploaded && p.uploadSession === p.session && p.uploadTab === p.tab)));
    if (i < 0) return false;
    list[i] = { ...list[i], clicked: now };
    save(path, list);
    return true;
  });
}

// The file a post carries, as the owner sees it on their button and the guard checks it at upload: its
// name, size and SHA-256. undefined when it isn't a readable regular file.
export const MEDIA_MAX = 512 * 1024 * 1024;
export function mediaOf(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MEDIA_MAX) return undefined;
    return { name: String(file).split('/').pop(), sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), bytes: st.size };
  } catch {
    return undefined;
  }
}

// The upload of the one file the owner approved with a post's text, on the approved page: one file per
// call, the same bytes they approved (its SHA-256), in the room that asked, once. Before the text is
// typed, or after it in the same session and tab. `where`: { tab, site }; `page`: the tab's URL.
export function useUpload(files, session, now = Date.now(), path = approvalsPath(), cwd, where, page) {
  if (!Array.isArray(files) || files.length !== 1) return false;
  // A full path to the file itself: the browser reads it after this check, so no link that could be
  // pointed elsewhere in between, and no relative path read from another folder.
  const file = String(files[0]);
  try {
    if (!file.startsWith('/') || lstatSync(file).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const m = mediaOf(file);
  if (!m) return false;
  return locked(path, () => {
    const list = loadPasses(path);
    const s = String(session ?? '');
    const i = list.findIndex((p) => p.media && p.media.sha256 === m.sha256 && !p.uploaded && !p.clicked && p.expires > now && passHere(cwd, p) && sameTarget(p.target, page) && (!p.usedAt || (p.session === s && p.tab === String(where.tab) && p.site === String(where.site))));
    if (i < 0) return false;
    list[i] = { ...list[i], uploaded: now, uploadSession: s, uploadTab: String(where.tab) };
    save(path, list);
    return true;
  });
}

// A one-off action the owner picked for one page (say, deleting a post that went out wrong): their
// Approve on a --delete button gives a few clicks in one tab that is on exactly that page, from the room that
// asked, within 10 minutes of the first, never any typing. Enough for a menu, its item and the
// confirm; the pass text is the fixed sentence "delete the post at <page>".
export const ACT_CLICKS = 4;
export const actText = (page) => `delete the post at ${normTarget(page)}`;
export function useActClick(session, tab, page, now = Date.now(), path = approvalsPath(), cwd) {
  const at = normTarget(page);
  if (!/^https:\/\//.test(at)) return false;
  return locked(path, () => {
    const list = loadPasses(path);
    const s = String(session ?? '');
    const here = (p) => p.act === 'delete' && p.target === at && sameText(p.text, actText(at)) && passHere(cwd, p);
    // One already started in this tab first; else a fresh one.
    let i = list.findIndex((p) => here(p) && p.usedAt && p.session === s && p.tab === String(tab) && now - p.usedAt < CLICK_WINDOW_MS && (p.clicks ?? 0) < ACT_CLICKS);
    if (i < 0) i = list.findIndex((p) => here(p) && !p.usedAt && p.expires > now);
    if (i < 0) return false;
    const p = list[i];
    list[i] = p.usedAt ? { ...p, clicks: (p.clicks ?? 0) + 1 } : { ...p, usedAt: now, session: s, tab: String(tab), clicks: 1 };
    save(path, list);
    return true;
  });
}

// Clicks that put the cursor in the compose box before anything is in it (without them, typing can
// land nowhere because the click into the text box was refused, and the pass is spent). Only while the pass is unused and its file (if any) not yet up, so the box holds nothing a
// click could post; up to 3, in one tab, on the approved page, from the room that asked. They never
// spend the pass: that is still the typing, then one Post click. With a file: click, type, upload, Post.
export const FOCUS_CLICKS = 3;
export function useFocusClick(session, tab, page, now = Date.now(), path = approvalsPath(), cwd) {
  return locked(path, () => {
    const list = loadPasses(path);
    const s = String(session ?? '');
    const t = String(tab);
    // Nothing waiting in this tab under any pass (text typed or a file up, not yet posted): a click
    // there could post it.
    if (list.some((p) => !p.clicked && ((p.usedAt && p.session === s && p.tab === t) || (p.uploaded && p.uploadSession === s && p.uploadTab === t)))) return false;
    const i = list.findIndex((p) => !p.usedAt && !p.act && !p.uploaded && p.expires > now && passHere(cwd, p) && sameTarget(p.target, page) && (p.focusClicks ?? 0) < FOCUS_CLICKS && (!p.focusTab || (p.focusTab === String(tab) && p.focusSession === s)));
    if (i < 0) return false;
    list[i] = { ...list[i], focusClicks: (list[i].focusClicks ?? 0) + 1, focusTab: String(tab), focusSession: s };
    save(path, list);
    return true;
  });
}
