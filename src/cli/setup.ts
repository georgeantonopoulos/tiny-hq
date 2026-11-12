// What setup asks and what it does with the answers, shared by the welcome page (tiny-hq setup, in the
// browser) and the typed questions (tiny-hq setup --terminal, and piped answers in scripts).

import { chmodSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_PATH, DATA_DIR, REPO_ROOT } from '../paths.ts';
import { DEFAULT_CONFIG, STYLES, cleanName, loadConfig, saveConfig, type Config, type ManagerStyle } from '../config.ts';
import { LABEL, OPEN_LABEL, openPlist, plist } from '../daemon/launchd.ts';
import { discoverProjects, isGone, isPlainPath } from '../discovery/scan.ts';
import { MAX_ROOMS } from '../office/layout.ts';
import { HOOKS, MARK, installedHooks, linkSkill, loadAgent, loadInstalled, readSettings, saveInstalled, skillLink, unlinkSkill, unloadAgent, withHooks, writeSettings, type HookSpec } from './install.ts';

export const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
export const untilde = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p === '~' ? homedir() : p);
export const has = (bin: string) => spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

export interface SetupChoices {
  officeName: string;
  ownerName: string;
  managerName: string;
  managerStyle: ManagerStyle;
  projectRoots: string[];
  extras: Config['extras'];
  briefing: boolean; // the manager's daily brief (at the time in settings, 08:30 unless changed)
  phone: boolean; // print the phone-access steps (set up by hand over Tailscale)
  login: boolean; // start the office when the owner logs in
  hooks: HookSpec['id'][];
  skill: boolean;
  rooms?: { chosen: string[]; offered: string[] }; // from the welcome page: which projects get rooms
}

// The answers setup suggests: the last ones saved, or good first-time defaults.
export function currentChoices(): SetupChoices {
  const first = !existsSync(CONFIG_PATH);
  const c = first ? { ...DEFAULT_CONFIG } : loadConfig(CONFIG_PATH);
  const macName = first ? ((spawnSync('id', ['-F'], { encoding: 'utf8' }).stdout ?? '').trim().split(' ')[0] ?? '') : '';
  const inst = loadInstalled(DATA_DIR);
  let had: string[] = [];
  try {
    had = installedHooks(readSettings());
  } catch {
    // a broken settings file is reported when saving
  }
  const found = c.projectRoots.filter((p) => existsSync(p));
  return {
    officeName: c.officeName,
    ownerName: cleanName(macName, c.ownerName),
    managerName: c.managerName,
    managerStyle: c.managerStyle,
    projectRoots: found.length ? found : c.projectRoots,
    extras: { ...c.extras },
    briefing: !!c.briefingTime,
    phone: !!c.remote,
    login: inst?.loginItems ?? true,
    hooks: inst ? inst.hooks : had.length ? HOOKS.filter((h) => had.some((x) => x.endsWith(`${MARK} ${h.id}`))).map((h) => h.id) : HOOKS.map((h) => h.id),
    skill: inst ? inst.skill : true,
  };
}

// A project the welcome page offers as a room.
export interface Offered {
  path: string;
  name: string;
  where: string; // its parent folder, "~/Dev"
  lastActive: number;
  recent: number; // Claude Code and Codex sessions in the last 30 days
  repo?: string; // "owner/name" when it has a GitHub remote
  chosen: boolean; // ticked to begin with
}

// Every project setup can find, best first, with the ones that should get a room ticked: the owner's
// earlier picks, else the busiest (up to the 12 rooms the floor holds).
export async function offeredRooms(roots: string[]): Promise<Offered[]> {
  const c = existsSync(CONFIG_PATH) ? loadConfig(CONFIG_PATH) : { ...DEFAULT_CONFIG };
  const keep = [...c.extraProjects, ...c.pinnedProjects].filter((p) => existsSync(p));
  const found = (await discoverProjects(undefined, undefined, keep, c.pinnedProjects, [], roots)).filter((p) => !isGone(p.path));
  const picked = c.pinnedProjects.length > 0;
  const busy = found.filter((p) => p.recentSessions > 0 || p.activity >= 0.2);
  const auto = new Set((busy.length ? busy : found).slice(0, busy.length ? MAX_ROOMS : 6).map((p) => p.path));
  return found.slice(0, 200).map((p) => {
    const remote = p.sources.git?.remote ?? '';
    const repo = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)?.[1];
    const chosen = picked ? c.pinnedProjects.includes(p.path) : !c.hiddenProjects.includes(p.path) && !c.archivedProjects.includes(p.path) && auto.has(p.path);
    return { path: p.path, name: p.name, where: tilde(dirname(p.path)), lastActive: p.lastActive, recent: p.recentSessions, ...(repo ? { repo } : {}), chosen };
  });
}

// Checks answers that came from the welcome page: names cleaned, only known options, only paths offered.
export function cleanChoices(raw: unknown, offered: readonly string[]): SetupChoices | string {
  if (!raw || typeof raw !== 'object') return 'no answers';
  const r = raw as Record<string, unknown>;
  const def = currentChoices();
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const x = (r.extras ?? {}) as Record<string, unknown>;
  const roots = Array.isArray(r.projectRoots) ? r.projectRoots.filter((p): p is string => typeof p === 'string').map((p) => untilde(p.trim())).filter((p) => isPlainPath(p)).slice(0, 10) : def.projectRoots;
  const rooms = (r.rooms ?? {}) as Record<string, unknown>;
  const chosen = Array.isArray(rooms.chosen) ? rooms.chosen.filter((p): p is string => typeof p === 'string' && offered.includes(p)) : [];
  return {
    officeName: cleanName(r.officeName, def.officeName),
    ownerName: cleanName(r.ownerName, def.ownerName),
    managerName: cleanName(r.managerName, def.managerName),
    managerStyle: STYLES.includes(r.managerStyle as ManagerStyle) ? (r.managerStyle as ManagerStyle) : def.managerStyle,
    projectRoots: roots.length ? roots : def.projectRoots,
    extras: { github: bool(x.github, def.extras.github), coffee: bool(x.coffee, def.extras.coffee), happenings: bool(x.happenings, def.extras.happenings) },
    briefing: bool(r.briefing, def.briefing),
    phone: bool(r.phone, def.phone),
    login: bool(r.login, def.login),
    hooks: Array.isArray(r.hooks) ? HOOKS.map((h) => h.id).filter((id) => (r.hooks as unknown[]).includes(id)) : def.hooks,
    skill: bool(r.skill, def.skill),
    rooms: { chosen, offered: [...offered] },
  };
}

// Room picks into settings: picked projects always get a room (the busiest 12 if more); the rest go
// to the archive cupboard, where they can be brought back. Nothing is hidden for good.
export function withRooms(c: Config, rooms: NonNullable<SetupChoices['rooms']>, activity: (p: string) => number = () => 0): Config {
  const chosen = [...new Set(rooms.chosen)].sort((a, b) => activity(b) - activity(a));
  const pinned = chosen.slice(0, MAX_ROOMS);
  const notChosen = rooms.offered.filter((p) => !chosen.includes(p));
  return {
    ...c,
    pinnedProjects: pinned,
    archivedProjects: [...new Set([...c.archivedProjects.filter((p) => !chosen.includes(p)), ...notChosen, ...chosen.slice(MAX_ROOMS)])],
    hiddenProjects: c.hiddenProjects.filter((p) => !chosen.includes(p)),
  };
}

export type Applied = { ok: true; hooks: HookSpec['id'][]; skill: boolean; login: boolean; notes: string[] } | { ok: false; error: string };

// Saves the answers, then adds (or takes out) what the owner said yes or no to outside ~/.tiny-hq.
// `outside: false` (setup --defaults) saves the settings only.
export function applySetup(ch: SetupChoices, opts: { outside: boolean; activity?: (p: string) => number }): Applied {
  // Read Claude Code's settings first: a broken file stops setup before anything is saved.
  let settings: ReturnType<typeof readSettings>;
  try {
    settings = readSettings();
  } catch (err) {
    return { ok: false, error: `Couldn't read ~/.claude/settings.json: ${err instanceof Error ? err.message : String(err)}. Fix that file (it must be valid JSON), then run setup again. Nothing was changed.` };
  }
  const before = existsSync(CONFIG_PATH) ? loadConfig(CONFIG_PATH) : { ...DEFAULT_CONFIG };
  let config: Config = {
    ...before,
    officeName: ch.officeName,
    ownerName: ch.ownerName,
    managerName: ch.managerName,
    managerStyle: ch.managerStyle,
    projectRoots: ch.projectRoots.length ? ch.projectRoots : before.projectRoots,
    extras: ch.extras,
  };
  if (ch.briefing) config.briefingTime = before.briefingTime ?? DEFAULT_CONFIG.briefingTime;
  else delete config.briefingTime;
  if (ch.rooms) config = withRooms(config, ch.rooms, opts.activity);
  saveConfig(CONFIG_PATH, config);
  // The office's commands run from Claude Code sessions whose PATH may not have this Node (nvm, a GUI launch).
  writeFileSync(join(DATA_DIR, 'node'), process.execPath + '\n', { mode: 0o600 });
  const notes: string[] = [];
  if (!opts.outside) return { ok: true, hooks: [], skill: false, login: false, notes };

  writeSettings(withHooks(settings, REPO_ROOT, ch.hooks));
  let skillOn = false;
  if (ch.skill) {
    const r = linkSkill(REPO_ROOT);
    skillOn = r !== 'taken';
    if (r === 'taken') notes.push(`${tilde(skillLink())} is already something of yours; left it alone.`);
  } else unlinkSkill(REPO_ROOT);
  for (const dir of ['hooks', 'manager']) for (const f of readdirSync(join(REPO_ROOT, dir))) if (statSync(join(REPO_ROOT, dir, f)).isFile() && !f.includes('.')) chmodSync(join(REPO_ROOT, dir, f), 0o755);
  chmodSync(join(REPO_ROOT, 'hooks', 'office-name.sh'), 0o755);
  if (ch.login) {
    loadAgent(LABEL, plist(process.execPath));
    loadAgent(OPEN_LABEL, openPlist(process.execPath));
  } else {
    unloadAgent(LABEL);
    unloadAgent(OPEN_LABEL);
  }
  saveInstalled(DATA_DIR, { hooks: ch.hooks, skill: skillOn, loginItems: ch.login, at: new Date().toISOString() });
  if (ch.extras.github && !has('gh')) notes.push('GitHub keeper: install the GitHub CLI and run `gh auth login`; it starts by itself after that.');
  return { ok: true, hooks: ch.hooks, skill: skillOn, login: ch.login, notes };
}

