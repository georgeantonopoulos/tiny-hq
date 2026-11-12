// Discovery: finds the owner's projects from Claude Code history, Codex history
// and git repos, and merges them into one list. Read-only. It reads session
// files only far enough to find the project folder; it never opens credential
// files, and it skips the old agent setups this workspace replaces.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MANAGER_DIR, REPO_ROOT } from '../paths.ts';

export type SourceKind = 'claude' | 'codex' | 'git';

export interface SourceHit {
  kind: SourceKind;
  path: string;
  sessions?: number;
  recentSessions?: number; // in the last 30 days
  lastActive?: number; // ms since epoch
  remote?: string;
  language?: string;
  times?: number[]; // when each session was last active (ms), for "what changed since"
  titles?: { at: number; title: string }[]; // recent conversation titles, newest first
}

export interface Project {
  id: string;
  name: string;
  path: string;
  sources: Partial<Record<SourceKind, SourceHit>>;
  lastActive: number;
  sessions: number;
  recentSessions: number;
  activity: number; // 0..1, drives room size
  times: number[];
  titles: { at: number; title: string }[];
}

const DAY = 24 * 60 * 60 * 1000;

// Never projects, even if the owner lists them: temporary and scratch folders.
const FORBIDDEN: readonly RegExp[] = [/^\/private\/(tmp|var)/, /^\/tmp(\/|$)/, /^\/var\/folders/];
export const isForbidden = (p: string) => FORBIDDEN.some((re) => re.test(p));

const EXCLUDE: readonly RegExp[] = [
  ...FORBIDDEN,
  /\/Library\/Application Support\/Claude\/.*scratch/i,
  /\/\.codex(\/|$)/, /\/Documents\/Codex\//, /\/\.claude(\/|$)/,
];

// A recorded folder must be a plain absolute path. Anything else (relative,
// control characters, absurdly long) is dropped: these strings end up in
// The manager's briefing, so they must not be able to carry instructions.
export function isPlainPath(p: unknown): p is string {
  return typeof p === 'string' && p.length < 400 && /^\/[^\x00-\x1f\x7f]*$/.test(p);
}

// Titles are untrusted text from session history: one line, short.
const cleanTitle = (t: string) => t.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

const mtimeOf = (file: string): number | undefined => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined; // deleted mid-scan
  }
};

const listDir = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

// "/Volumes/Macintosh HD/Users/..." is often just another name for the main disk,
// but on the owner's Mac it's a second disk (an older system) with its own folders.
// Drop the prefix only when the recorded folder isn't there and the main-disk one is.
export function normalisePath(p: string, home = homedir(), exists: (p: string) => boolean = existsSync): string {
  let out = p.replace(/\/+$/, '');
  const onMain = out.replace(/^\/Volumes\/Macintosh HD(?=\/Users\/)/, '');
  if (onMain !== out && !exists(out) && exists(onMain)) out = onMain;
  try {
    out = realpathSync(out);
  } catch {
    // folder may be gone; keep the recorded path
  }
  return out || home;
}

// Temporary working copies of the office's own code sit next to it
// (~/.tiny-hq/app-mem, -teamwork...). Once deleted they no longer look
// like git worktrees, but their Claude history is still there: skip them by name.
export function isOfficeCopy(p: string, repoRoot = REPO_ROOT, exists = existsSync): boolean {
  // Only folders that are gone: a real project next door (say tiny-hq-ios) stays.
  return dirname(p) === dirname(repoRoot) && basename(p).startsWith(`${basename(repoRoot)}-`) && !exists(p);
}

export function isExcluded(p: string, home = homedir(), alwaysInclude: readonly string[] = []): boolean {
  // Folders the owner listed in config ("extraProjects") skip the usual filters,
  // never the forbidden ones.
  if (alwaysInclude.includes(p)) return isForbidden(p);
  if (p === home || p === join(home, 'Dev') || p === join(home, 'Downloads') || p === '/') return true;
  if (/\/\.tiny-hq(-dev)?(\/|$)/.test(p)) return true; // the office's own data

  if (isOfficeCopy(p)) return true;
  if (p === MANAGER_DIR || p.startsWith(MANAGER_DIR + '/')) return true; // the manager's own folder isn't a project
  if (EXCLUDE.some((re) => re.test(p))) return true;
  return isLinkedWorktree(p);
}

// The folder no longer exists (moved or deleted): its room goes, notes stay with the manager.
// Only a definite "not there" counts; a folder macOS won't let the office look into
// (Documents without permission) is not gone.
export function isGone(p: string): boolean {
  try {
    statSync(p);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

// A linked git worktree (".git" is a file) is a working copy of another
// project, not a project of its own.
export function isLinkedWorktree(p: string): boolean {
  try {
    return statSync(join(p, '.git')).isFile();
  } catch {
    return false;
  }
}

// Reads the first part of a JSONL file and returns the first "cwd" value.
export function firstCwd(file: string, bytes = 64 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString('utf8'));
    const cwd: unknown = m?.[1] ? JSON.parse(`"${m[1]}"`) : undefined;
    return isPlainPath(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function addSession(map: Map<string, SourceHit>, kind: SourceKind, path: string, mtime: number, now: number, title?: string) {
  const hit = map.get(path) ?? { kind, path, sessions: 0, recentSessions: 0, lastActive: 0, times: [], titles: [] };
  hit.times!.push(mtime);
  if (title && now - mtime < 7 * DAY) hit.titles!.push({ at: mtime, title: cleanTitle(title) });
  hit.sessions = (hit.sessions ?? 0) + 1;
  if (now - mtime < 30 * DAY) hit.recentSessions = (hit.recentSessions ?? 0) + 1;
  hit.lastActive = Math.max(hit.lastActive ?? 0, mtime);
  map.set(path, hit);
}

export function scanClaude(home = homedir(), now = Date.now()): SourceHit[] {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return [];
  const hits = new Map<string, SourceHit>();
  for (const dir of listDir(root)) {
    if (!dir.isDirectory()) continue;
    const full = join(root, dir.name);
    for (const f of listDir(full)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = join(full, f.name);
      const cwd = firstCwd(file);
      const mtime = mtimeOf(file);
      if (!cwd || mtime === undefined) continue;
      addSession(hits, 'claude', normalisePath(cwd, home), mtime, now);
    }
  }
  return [...hits.values()];
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  for (const e of listDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export function scanCodex(home = homedir(), now = Date.now()): SourceHit[] {
  const hits = new Map<string, SourceHit>();
  const seen = new Set<string>();
  // Session files (recent history).
  for (const file of walkJsonl(join(home, '.codex', 'sessions'))) {
    const cwd = firstCwd(file, 16 * 1024);
    const mtime = mtimeOf(file);
    if (!cwd || mtime === undefined) continue;
    seen.add(basename(file));
    addSession(hits, 'codex', normalisePath(cwd, home), mtime, now);
  }
  // Thread databases, opened read-only. Codex keeps the live one at
  // ~/.codex/state_5.sqlite and an older copy under ~/.codex/sqlite/; read
  // both and count each thread once.
  const threads = new Set<string>();
  for (const db of [join(home, '.codex', 'state_5.sqlite'), join(home, '.codex', 'sqlite', 'state_5.sqlite')]) {
    if (!existsSync(db)) continue;
    let conn: DatabaseSync | undefined;
    try {
      conn = new DatabaseSync(db, { readOnly: true });
      const rows = conn.prepare('SELECT id, cwd, updated_at, rollout_path, title FROM threads WHERE cwd IS NOT NULL').all() as {
        id: unknown;
        cwd: unknown;
        updated_at: number;
        rollout_path: string | null;
        title: unknown;
      }[];
      for (const r of rows) {
        if (!isPlainPath(r.cwd) || typeof r.updated_at !== 'number') continue;
        const key = String(r.id);
        if (threads.has(key)) continue;
        threads.add(key);
        const ms = r.updated_at < 1e12 ? r.updated_at * 1000 : r.updated_at;
        const title = typeof r.title === 'string' ? r.title : undefined;
        if (r.rollout_path && seen.has(basename(r.rollout_path))) {
          // Already counted from its session file; keep only its title.
          const hit = hits.get(normalisePath(r.cwd, home));
          if (hit && title && now - ms < 7 * DAY) hit.titles!.push({ at: ms, title: cleanTitle(title) });
          continue;
        }
        addSession(hits, 'codex', normalisePath(r.cwd, home), ms, now, title);
      }
    } catch {
      // schema changed or locked: the other sources are enough
    } finally {
      conn?.close();
    }
  }
  return [...hits.values()];
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', py: 'Python', rs: 'Rust', swift: 'Swift',
  kt: 'Kotlin', go: 'Go', cpp: 'C++', c: 'C', h: 'C', rb: 'Ruby', html: 'HTML', cs: 'C#', java: 'Java',
};

const execFileP = promisify(execFile);

async function git(path: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return '';
  }
}

// Runs fn over items, at most `limit` at a time.
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function findRepos(roots: string[], depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (existsSync(join(dir, '.git'))) {
      out.push(dir);
      return;
    }
    if (d === 0) return;
    for (const e of listDir(dir)) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(dir, e.name), d - 1);
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r, depth);
  return out;
}

export async function scanGit(home = homedir(), roots = ['Dev', 'Developer', 'Projects', 'Sites', 'code', 'src'].map((r) => join(home, r)), depth = 3): Promise<SourceHit[]> {
  return pool(findRepos(roots, depth), 6, async (repo) => {
    const path = normalisePath(repo, home);
    const [lastRaw, remoteRaw, files] = await Promise.all([
      git(repo, ['log', '-1', '--format=%ct']),
      git(repo, ['remote', 'get-url', 'origin']),
      git(repo, ['ls-files']),
    ]);
    const last = Number(lastRaw) * 1000 || 0;
    const remote = remoteRaw.replace(/\/\/[^@/]*@/, '//');
    const counts = new Map<string, number>();
    for (const f of files.split('\n')) {
      const lang = LANG_BY_EXT[f.slice(f.lastIndexOf('.') + 1).toLowerCase()];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    const language = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { kind: 'git' as const, path, lastActive: last, ...(remote ? { remote } : {}), ...(language ? { language } : {}) };
  });
}

const prettyName = (p: string) =>
  basename(p).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60).trim() || 'Untitled';

// Pure: merges hits from all sources into projects, one per folder.
export function mergeProjects(hits: SourceHit[], now = Date.now(), home = homedir(), alwaysInclude: readonly string[] = [], pinned: readonly string[] = [], hidden: readonly string[] = []): Project[] {
  const byPath = new Map<string, Project>();
  for (const h of hits) {
    if (hidden.includes(h.path) || isExcluded(h.path, home, alwaysInclude)) continue; // hidden: the owner retired the room (config "hiddenProjects")
    const key = h.path.toLowerCase();
    const p = byPath.get(key) ?? {
      id: '',
      name: prettyName(h.path),
      path: h.path,
      sources: {},
      lastActive: 0,
      sessions: 0,
      recentSessions: 0,
      activity: 0,
      times: [],
      titles: [],
    };
    p.times.push(...(h.times ?? []));
    p.titles.push(...(h.titles ?? []));
    const existing = p.sources[h.kind];
    p.sources[h.kind] = existing
      ? {
          ...existing,
          sessions: (existing.sessions ?? 0) + (h.sessions ?? 0),
          recentSessions: (existing.recentSessions ?? 0) + (h.recentSessions ?? 0),
          lastActive: Math.max(existing.lastActive ?? 0, h.lastActive ?? 0),
        }
      : h;
    p.sessions += h.sessions ?? 0;
    p.recentSessions += h.recentSessions ?? 0;
    p.lastActive = Math.max(p.lastActive, h.lastActive ?? 0);
    byPath.set(key, p);
  }
  const projects = [...byPath.values()];
  for (const p of projects) {
    p.titles.sort((a, b) => b.at - a.at);
    // Codex reviews and duplicates add noise; keep distinct titles only.
    p.titles = p.titles.filter((t, i, all) => all.findIndex((u) => u.title === t.title) === i).slice(0, 8);
  }
  // Activity: recent sessions (log scale) plus a recency bonus that fades over 60 days.
  const maxRecent = Math.max(1, ...projects.map((p) => p.recentSessions));
  for (const p of projects) {
    const recency = Math.max(0, 1 - (now - p.lastActive) / (60 * DAY));
    const volume = Math.log1p(p.recentSessions) / Math.log1p(maxRecent);
    p.activity = Math.round((0.6 * volume + 0.4 * recency) * 100) / 100;
  }
  // Pinned folders (config "pinnedProjects") always get a room, however quiet.
  const pin = (p: Project) => (pinned.includes(p.path) ? 1 : 0);
  projects.sort((a, b) => pin(b) - pin(a) || b.activity - a.activity || b.lastActive - a.lastActive);
  // Two folders with the same name get their parent folder added: "Atlas (Dev_OLD)".
  const byName = new Map<string, Project[]>();
  for (const p of projects) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const group of byName.values()) {
    if (group.length > 1) for (const p of group) p.name = `${p.name} (${basename(dirname(p.path))})`;
  }
  const used = new Set<string>(['manager', 'archive', 'lounge', 'desk']); // reserved for the manager's office, the archive, the coffee room and the owner's desk
  for (const p of projects) {
    let id = basename(p.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    while (used.has(id)) id += '-2';
    used.add(id);
    p.id = id;
  }
  return projects;
}

// Never throws: a source that fails just contributes nothing.
export async function discoverProjects(home = homedir(), now = Date.now(), alwaysInclude: readonly string[] = [], pinned: readonly string[] = [], hidden: readonly string[] = [], roots?: readonly string[]): Promise<Project[]> {
  const safe = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  const git = await scanGit(home, roots ? [...roots] : undefined).catch(() => [] as SourceHit[]);
  // The owner's listed folders: each one itself (no digging into subfolders).
  const extra = await scanGit(home, [...alwaysInclude], 0).catch(() => [] as SourceHit[]);
  return mergeProjects([...safe(() => scanClaude(home, now), []), ...safe(() => scanCodex(home, now), []), ...git, ...extra], now, home, alwaysInclude, pinned, hidden);
}
