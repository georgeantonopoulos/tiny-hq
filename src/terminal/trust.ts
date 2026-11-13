// Claude Code only starts in a folder the owner has trusted (its "Do you trust the files in this
// folder?" prompt), remembered in ~/.claude.json under projects[<folder>].hasTrustDialogAccepted.
// A background session can't show that prompt, so `claude --bg` in an archive project failed with
// "Workspace not trusted" and nobody could fix it without the owner typing a command.
// Now the office asks them with a button, and their Approve marks the folder trusted here.

import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export const claudeConfig = (home = homedir()) => `${home}/.claude.json`;

type Config = { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };

// Trusted only if this folder itself was accepted. A trusted parent isn't enough for a background
// session: with ~/Dev trusted, `claude --bg` in a new ~/Dev/<project> still says "Workspace not
// trusted", so delegate must put up its "Trust and start" button instead of failing.
export function isTrusted(folder: string, file = claudeConfig()): boolean {
  let cfg: Config;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8')) as Config;
  } catch {
    return false;
  }
  return cfg.projects?.[folder.replace(/\/+$/, '')]?.hasTrustDialogAccepted === true;
}

// Marks one folder trusted, keeping everything else in the file as it was. Only ever called from
// The owner's own Approve click.
export function trustFolder(folder: string, at = claudeConfig()): void {
  if (!folder.startsWith('/') || /[\x00-\x1f]/.test(folder)) throw new Error('not a plain folder path');
  // A linked ~/.claude.json (a dotfiles folder) is written where it points, so the link stays.
  let file = at;
  try {
    file = realpathSync(at);
  } catch {
    // not there yet
  }
  let raw: string | undefined;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // No file yet (Claude Code never started under this account): start one, private like Claude Code's.
  const cfg = (raw === undefined ? {} : JSON.parse(raw)) as Config & Record<string, unknown>;
  const projects = (cfg.projects ??= {});
  projects[folder] = { ...(projects[folder] ?? {}), hasTrustDialogAccepted: true };
  const tmp = `${file}.office-trust.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: raw === undefined ? 0o600 : statSync(file).mode & 0o777 });
  renameSync(tmp, file);
}
