// Which room a button raised with ask belongs to: the asking session's own room, else the
// room the folder is in, or a worktree or clone of (same git repository, or the same remote).
// A button raised from a worktree kept outside .claude/worktrees was filed under that folder,
// matched no room, and showed over nobody's head.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RepoOf {
  /** The repository's shared .git folder (the same for every worktree of it). */
  commonDir?: string;
  /** origin's address, normalised to host/owner/repo. */
  remote?: string;
}

/** git@github.com:o/r.git, https://github.com/o/r and ssh://git@github.com/o/r all become github.com/o/r. */
export function normRemote(url: string): string | undefined {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/i.exec(u);
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : undefined;
}

export function repoOf(folder: string): RepoOf {
  const git = (...a: string[]) => {
    try {
      return execFileSync('git', ['-C', folder, ...a], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  let commonDir: string | undefined;
  try {
    commonDir = common ? realpathSync(common) : undefined;
  } catch {
    commonDir = common;
  }
  const url = git('config', '--get', 'remote.origin.url');
  return { commonDir, remote: url ? normRemote(url) : undefined };
}

/** The room whose saved chats hold this session: the room it was started in (Claude Code files a
 *  chat under the folder it started in, even after it moves to a worktree elsewhere), so a
 *  session working in a worktree of another repo still asks over its own room's head. */
export function roomOfSession(sessionId: string, rooms: string[], projectsDir = join(homedir(), '.claude', 'projects')): string | undefined {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return undefined;
  // Claude Code has named a folder's chat folder two ways ("Macintosh HD" kept its space once).
  const dirs = (r: string) => [...new Set([r.replace(/[^a-zA-Z0-9]/g, '-'), r.replace(/[^a-zA-Z0-9 ]/g, '-')])];
  return [...rooms].sort((a, b) => b.length - a.length).find((r) => dirs(r).some((d) => existsSync(join(projectsDir, d, `${sessionId}.jsonl`))));
}

/**
 * The room folder `folder` belongs to, or undefined when it matches none.
 * 1. The folder is a room or inside one (the deepest room wins, so a nested room keeps its own).
 * 2. Else it shares a git repository with a room (a worktree kept anywhere).
 * 3. Else it has the same origin remote as a room (a separate clone).
 */
export function roomOfFolder(folder: string, rooms: string[], repo: (f: string) => RepoOf = repoOf): string | undefined {
  const inside = rooms.filter((r) => folder === r || folder.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  if (inside) return inside;
  const mine = repo(folder);
  if (!mine.commonDir && !mine.remote) return undefined;
  const theirs = rooms.map((r) => ({ r, repo: repo(r) }));
  return (
    (mine.commonDir ? theirs.find((t) => t.repo.commonDir === mine.commonDir)?.r : undefined) ??
    (mine.remote ? theirs.find((t) => t.repo.remote === mine.remote)?.r : undefined)
  );
}
