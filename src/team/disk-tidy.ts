// Disk tidy (an extra, off unless the owner switches it on: extras.diskTidy in ~/.tiny-hq/config.json).
// Build output piles up fast across many projects. A plain check on the office tick, no Claude
// session and no tokens: when free space drops under LOW_GB, idle rebuildable build folders are
// removed, oldest first, until free space is back over ENOUGH_GB.
//
// What counts as rebuildable build output (one declaration, KINDS below):
//   - Rust `target/` (has CACHEDIR.TAG and a debug/ or release/ folder)
//   - Next.js `.next/` (has BUILD_ID or cache/)
//   - Xcode `DerivedData/` inside a project
//   - CMake build folders (`build/` with CMakeCache.txt)
// node_modules, dist, virtualenvs and caches outside these are never touched: they are cheap, or
// may be shipped, or need the owner's say.
//
// Where it looks: the projects in the owner's project folders (projectRoots) and extra projects,
// plus Claude Code background jobs' temp folders.
//
// Safety: inside a git repo the folder must be git-ignored with no tracked files. Nothing is
// touched while it was written to in the last IDLE_DAYS, while a busy session or any open terminal
// session works anywhere in the same project (a build may point at another worktree's target), or,
// for a background job's temp folder, while that job is still working.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, statfsSync, writeFileSync, lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const LOW_GB = 30; // start clearing under this much free space
export const ENOUGH_GB = 80; // stop once this much is free again
export const IDLE_DAYS = 2; // untouched for this long before it counts as idle
export const EVERY_MS = 60 * 60_000; // look at most once an hour while space is low

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;

export type Kind = 'rust' | 'next' | 'xcode' | 'cmake';
interface KindRule { name: string; is(dir: string, entries: string[]): boolean }
export const KINDS: Record<Kind, KindRule> = {
  rust: { name: 'target', is: (_d, e) => e.includes('CACHEDIR.TAG') && (e.includes('debug') || e.includes('release')) },
  next: { name: '.next', is: (_d, e) => e.includes('BUILD_ID') || e.includes('cache') },
  xcode: { name: 'DerivedData', is: () => true },
  cmake: { name: 'build', is: (_d, e) => e.includes('CMakeCache.txt') },
};
const NAMES = new Set(Object.values(KINDS).map((k) => k.name));
// Never walked into: source control, dependencies, environments.
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.Trash']);

export interface Candidate {
  path: string;
  kind: Kind;
  project: string; // ~/Dev/<name>, or the job folder for a background job's temp folder
  newest: number; // newest change seen in its top two levels (ms)
  bytes?: number;
  keep?: string; // why it stays, if it does
}

export function kindOf(dir: string, entries: string[]): Kind | undefined {
  const name = basename(dir);
  for (const [kind, rule] of Object.entries(KINDS) as [Kind, KindRule][]) {
    if (rule.name === name && rule.is(dir, entries)) return kind;
  }
  return undefined;
}

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const mtime = (p: string): number => {
  try {
    return lstatSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/** Newest change in a folder's top two levels: cheap, and a running build always touches them. */
export function newestIn(dir: string): number {
  let newest = mtime(dir);
  for (const a of list(dir)) {
    const p = join(dir, a);
    newest = Math.max(newest, mtime(p));
    try {
      if (statSync(p).isDirectory()) for (const b of list(p)) newest = Math.max(newest, mtime(join(p, b)));
    } catch {
      /* gone meanwhile */
    }
  }
  return newest;
}

/** Build folders under `root`, at most `depth` levels down, without walking into them. */
export function findBuilds(root: string, project: string, depth: number, out: Candidate[] = []): Candidate[] {
  if (depth < 0) return out;
  for (const e of list(root)) {
    if (SKIP.has(e)) continue;
    const p = join(root, e);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (NAMES.has(e)) {
      const kind = kindOf(p, list(p));
      if (kind) {
        out.push({ path: p, kind, project, newest: newestIn(p) });
        continue;
      }
    }
    findBuilds(p, project, depth - 1, out);
  }
  return out;
}

const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return undefined;
  }
};

/** Inside a git repo: only an ignored folder with nothing tracked in it. Outside one: fine. */
export function gitAllows(dir: string): string | undefined {
  const parent = dirname(dir);
  if (git(parent, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return undefined;
  if (git(parent, ['check-ignore', '-q', basename(dir)]) === undefined) return 'not git-ignored';
  if ((git(parent, ['ls-files', '--', basename(dir)]) ?? 'x').trim()) return 'has tracked files';
  return undefined;
}

function jobWorking(jobDir: string): boolean {
  try {
    const s = JSON.parse(readFileSync(join(jobDir, 'state.json'), 'utf8')) as { state?: string };
    return s.state === 'working' || s.state === 'blocked';
  } catch {
    return false;
  }
}

/** The projects the office looks in: each folder inside a project folder, and each extra project. */
export function projectsIn(roots: string[], extra: string[] = []): string[] {
  const out = new Set<string>();
  const isDir = (p: string) => {
    try {
      return lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (const root of roots) for (const p of list(root)) if (!SKIP.has(p) && isDir(join(root, p))) out.add(join(root, p));
  for (const p of extra) if (isDir(p) && ![...out].some((o) => p === o || p.startsWith(`${o}/`))) out.add(p);
  return [...out];
}

/** Every build folder the office looks at: the owner's projects, and background jobs' temp folders. */
export function allBuilds(projects: string[], home = homedir()): Candidate[] {
  const out: Candidate[] = [];
  for (const project of projects) findBuilds(project, project, 6, out);
  const jobs = join(home, '.claude', 'jobs');
  for (const j of list(jobs)) findBuilds(join(jobs, j, 'tmp'), join(jobs, j), 3, out);
  return out;
}

/** Why a build folder must stay, or undefined when it may go. `busy` = folders busy sessions work in. */
export function keepReason(c: Candidate, busy: string[], now: number): string | undefined {
  if (now - c.newest < IDLE_DAYS * DAY) return `used in the last ${IDLE_DAYS} days`;
  if (busy.some((b) => b === c.project || b.startsWith(`${c.project}/`))) return 'a session is busy in this project';
  if (c.project.includes('/.claude/jobs/') && jobWorking(c.project)) return 'its background job is still working';
  return gitAllows(c.path);
}

/** Which idle folders to clear, oldest first, until enough is free. */
export function pickToClear(cands: Candidate[], freeBytes: number, enough = ENOUGH_GB * GB): Candidate[] {
  const pick: Candidate[] = [];
  let free = freeBytes;
  for (const c of [...cands].filter((x) => !x.keep).sort((a, b) => a.newest - b.newest)) {
    if (free >= enough) break;
    pick.push(c);
    free += c.bytes ?? 0;
  }
  return pick;
}

export function freeBytes(path = '/'): number {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
}

export function sizeOf(dir: string): number {
  try {
    return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 600_000 }).split('\t')[0]) * 1024;
  } catch {
    return 0;
  }
}

/** Same as sizeOf without holding up the office while du walks a big folder. */
export function sizeOfLater(dir: string): Promise<number> {
  return new Promise((ok) => execFile('du', ['-sk', dir], { timeout: 600_000 }, (err, out) => ok(err ? 0 : Number(String(out).split('\t')[0]) * 1024)));
}

/** Removes a folder without holding up the office (rm runs on its own). */
export function remove(dir: string): Promise<boolean> {
  return new Promise((ok) => {
    const p = spawn('rm', ['-rf', '--', dir], { stdio: 'ignore' });
    p.on('exit', (code) => ok(code === 0));
    p.on('error', () => ok(false));
  });
}

export const gb = (b: number): string => `${(b / GB).toFixed(1)} GB`;

export interface TidyLog { at: number; freeBefore: number; freeAfter: number; cleared: { path: string; bytes: number }[] }
export const tidyLogPath = (dataDir: string) => join(dataDir, 'disk-tidy.json');
export function loadTidyLog(path: string): TidyLog[] {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TidyLog[];
  } catch {
    return [];
  }
}
export function addTidyLog(path: string, entry: TidyLog): void {
  writeFileSync(path, `${JSON.stringify([...loadTidyLog(path), entry].slice(-50), null, 2)}\n`);
}

/** Measures every candidate and marks the ones that must stay. */
export function survey(projects: string[], busy: string[], now = Date.now(), home = homedir(), measureKept = false): Candidate[] {
  return allBuilds(projects, home).map((c) => {
    const keep = keepReason(c, busy, now);
    return { ...c, keep, bytes: keep && !measureKept ? undefined : sizeOf(c.path) };
  });
}

/** Clears the picked folders; returns what went. */
export async function clear(pick: Candidate[]): Promise<{ path: string; bytes: number }[]> {
  const done: { path: string; bytes: number }[] = [];
  for (const c of pick) if (await remove(c.path)) done.push({ path: c.path, bytes: c.bytes ?? 0 });
  return done;
}

/** Folders where a session is busy now, plus every open terminal session of the owner's (their own
 * builds aren't reported as busy, so any open one holds its project). */
export async function busyFolders(): Promise<string[]> {
  const { allSessions, interactiveSessions } = await import('../terminal/sessions.ts');
  const [bg, mine] = await Promise.all([allSessions().catch(() => []), interactiveSessions().catch(() => [])]);
  return [...bg.filter((s) => s.status === 'busy').map((s) => s.realCwd), ...mine.map((s) => s.realCwd ?? '')].filter(Boolean);
}

let lastLook = 0;
/** The office tick: nothing at all unless free space is under LOW_GB, then at most once an hour. */
export async function tidyDiskIfLow(dataDir: string, projects: string[], now = Date.now()): Promise<TidyLog | undefined> {
  const before = freeBytes();
  if (before >= LOW_GB * GB || now - lastLook < EVERY_MS) return undefined;
  lastLook = now;
  const busy = await busyFolders();
  const cands = allBuilds(projects).map((c) => ({ ...c, keep: keepReason(c, busy, now) }));
  for (const c of cands) if (!c.keep) c.bytes = await sizeOfLater(c.path);
  const pick = pickToClear(cands, before);
  if (!pick.length) {
    console.log(`disk: ${gb(before)} free and nothing idle to clear`);
    return undefined;
  }
  const cleared = await clear(pick);
  const entry = { at: now, freeBefore: before, freeAfter: freeBytes(), cleared };
  addTidyLog(tidyLogPath(dataDir), entry);
  console.log(`disk: cleared ${cleared.length} idle build folders, ${gb(before)} → ${gb(entry.freeAfter)} free`);
  return entry;
}
