// What Tiny HQ adds to the owner's Mac outside its own folder, each only with their yes, and how
// each comes off again: five Claude Code hooks (in ~/.claude/settings.json), the theoffice skill
// (a link in ~/.claude/skills) and two login items (launchd agents). Every hook command carries the
// marker `# tiny-hq` so uninstall removes exactly what was added and nothing of the owner's.
// What was added is also recorded in <dataDir>/installed.json.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MARK = '# tiny-hq';

export interface HookSpec {
  id: 'name-tag' | 'waiting' | 'public-posts' | 'room-questions' | 'screen-clicks';
  event: 'SessionStart' | 'PermissionRequest' | 'PreToolUse' | 'Stop';
  matcher?: string;
  file: string; // under <app>/hooks
  what: string; // the consent line: what it does, in plain words
}

export const HOOKS: HookSpec[] = [
  {
    id: 'name-tag',
    event: 'SessionStart',
    file: 'office-name.sh',
    what: "Name tags: when a Claude Code session starts in one of your rooms, it's told its office name and who its manager is. Prints nothing anywhere else.",
  },
  {
    id: 'waiting',
    event: 'PermissionRequest',
    matcher: '*',
    file: 'office-waiting.mjs',
    what: 'Waiting hand: when a session stops at a permission prompt, the office notes it and puts a hand over that room so you see it. Never answers the prompt.',
  },
  {
    id: 'public-posts',
    event: 'PreToolUse',
    matcher: 'Bash|mcp__claude-in-chrome__.*|mcp__plugin_playwright_playwright__.*|mcp__playwright__.*',
    file: 'public-post-guard.mjs',
    what: 'Public-post guard: any session about to comment, post or upload on a public site (GitHub comments, social sites, forums) stops and asks you first, showing the exact action.',
  },
  {
    id: 'room-questions',
    event: 'Stop',
    file: 'room-ask-guard.mjs',
    what: "Questions as buttons: when a room's Claude asks you something in its chat instead of putting up a question button, it's sent back once to put it on a button, so you see a question mark over that room. Only in your rooms.",
  },
  {
    id: 'screen-clicks',
    event: 'PreToolUse',
    matcher: 'Bash',
    file: 'screen-click-guard.mjs',
    what: "Clicks wait for you: when a room tests a desktop app, its clicks and typing wait until you've left the keyboard and mouse alone for 30 s, so they never land under your hands. Only in your rooms.",
  },
];

type HookEntry = { type?: string; command?: string; timeout?: number };
type Matcher = { matcher?: string; hooks?: HookEntry[] };
type Settings = { hooks?: Record<string, Matcher[]> } & Record<string, unknown>;

// A path as one shell word, whatever it holds (spaces, $, backticks): single quotes, with ' itself escaped.
export const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function hookCommand(app: string, h: HookSpec): string {
  return `${h.file.endsWith('.sh') ? 'sh' : 'node'} ${shellWord(join(app, 'hooks', h.file))}  ${MARK} ${h.id}`;
}

const ours = (c: unknown) => typeof c === 'string' && c.includes(MARK);

// Adds the chosen hooks (replacing older copies of ours); everything else in the file is kept.
export function withHooks(settings: Settings, app: string, ids: readonly HookSpec['id'][]): Settings {
  const out: Settings = { ...withoutHooks(settings) };
  const hooks: Record<string, Matcher[]> = { ...(out.hooks ?? {}) };
  for (const h of HOOKS.filter((x) => ids.includes(x.id))) {
    const entry: Matcher = { ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: hookCommand(app, h), timeout: 5 }] };
    hooks[h.event] = [...(hooks[h.event] ?? []), entry];
  }
  return { ...out, hooks };
}

// Takes out every hook command of ours, and any matcher left empty by that.
export function withoutHooks(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  const hooks: Record<string, Matcher[]> = {};
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) {
      hooks[event] = list;
      continue;
    }
    const kept = list
      .map((m) => (Array.isArray(m?.hooks) ? { ...m, hooks: m.hooks.filter((h) => !ours(h?.command)) } : m))
      .filter((m) => !Array.isArray(m?.hooks) || m.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _drop, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

export const installedHooks = (settings: Settings): string[] =>
  Object.values(settings.hooks ?? {}).flatMap((list) => (Array.isArray(list) ? list.flatMap((m) => (m?.hooks ?? []).map((h) => h?.command).filter(ours) as string[]) : []));

const settingsFile = (home: string) => join(home, '.claude', 'settings.json');

export function readSettings(home = homedir()): Settings {
  const f = settingsFile(home);
  if (!existsSync(f)) return {};
  const raw: unknown = JSON.parse(readFileSync(f, 'utf8')); // a broken file stops the install: never overwrite it
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${f} isn't a JSON object; fix it first`);
  return raw as Settings;
}

// Writes ~/.claude/settings.json only when it changes, keeping a one-off copy of the owner's
// original beside it. It may be a link into a dotfiles folder: the real file is written, never the
// link replaced. Its permissions stay as they were (it can hold tokens, so often 0600).
export function writeSettings(s: Settings, home = homedir()): boolean {
  const link = settingsFile(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  const f = existsSync(link) ? realpathSync(link) : link;
  const text = JSON.stringify(s, null, 2) + '\n';
  if (existsSync(f) && JSON.stringify(JSON.parse(readFileSync(f, 'utf8'))) === JSON.stringify(s)) return false;
  const mode = existsSync(f) ? statSync(f).mode & 0o777 : 0o600;
  const backup = `${link}.before-tiny-hq`;
  if (existsSync(f) && !existsSync(backup)) copyFileSync(f, backup);
  const tmp = `${f}.tiny-hq-tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, f);
  return true;
}

// ---- the theoffice skill: a link, never a copy, and never over something of the owner's ----
export const skillLink = (home = homedir()) => join(home, '.claude', 'skills', 'theoffice');

export function linkSkill(app: string, home = homedir()): 'added' | 'already' | 'taken' {
  const link = skillLink(home);
  const target = join(app, 'skills', 'theoffice');
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() && readlinkSync(link) === target) return 'already';
    return 'taken';
  } catch {
    // not there yet
  }
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(target, link);
  return 'added';
}

export function unlinkSkill(app: string, home = homedir()): boolean {
  const link = skillLink(home);
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === join(app, 'skills', 'theoffice')) {
      unlinkSync(link);
      return true;
    }
  } catch {
    // not there
  }
  return false;
}

// ---- login items ----
export const agentsDir = (home = homedir()) => join(home, 'Library', 'LaunchAgents');

export function loadAgent(label: string, text: string, home = homedir()): void {
  mkdirSync(agentsDir(home), { recursive: true });
  const file = join(agentsDir(home), `${label}.plist`);
  unloadAgent(label, home);
  writeFileSync(file, text);
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, file], { stdio: 'ignore' });
}

export function unloadAgent(label: string, home = homedir()): boolean {
  const file = join(agentsDir(home), `${label}.plist`);
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${label}`], { stdio: 'ignore' });
  } catch {
    // wasn't loaded
  }
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

// ---- the record of what was added ----
export interface Installed {
  hooks: HookSpec['id'][];
  skill: boolean;
  loginItems: boolean;
  at: string;
}

export function loadInstalled(dataDir: string): Installed | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'installed.json'), 'utf8')) as Partial<Installed>;
    return { hooks: Array.isArray(raw.hooks) ? raw.hooks.filter((h): h is HookSpec['id'] => HOOKS.some((x) => x.id === h)) : [], skill: raw.skill === true, loginItems: raw.loginItems === true, at: String(raw.at ?? '') };
  } catch {
    return undefined;
  }
}

export function saveInstalled(dataDir: string, i: Installed): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, 'installed.json'), JSON.stringify(i, null, 2) + '\n', { mode: 0o600 });
}
