// The owner's settings for the office, in ~/.tiny-hq/config.json. The setup wizard
// (tiny-hq setup) writes it; it's also written with defaults on first run, so it's easy to find and edit.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { remoteFrom, type RemoteConfig } from './daemon/remote.ts';
import { parseTime } from './daemon/brief.ts';

export type ManagerStyle = 'calm' | 'whimsical' | 'plain';
export const STYLES: readonly ManagerStyle[] = ['calm', 'whimsical', 'plain'];

export interface Config {
  officeName: string; // the office's name, on the sign over the door (the top bar and the page title)
  ownerName: string; // what the manager calls the owner (the page says "you")
  managerName: string; // the manager's name on the floor and in their own words
  managerStyle: ManagerStyle; // how the manager talks: calm, whimsical or plain
  projectRoots: string[]; // folders searched for git projects (each to three levels deep)
  extras: { github: boolean; coffee: boolean; happenings: boolean }; // optional features, each off unless switched on
  goalRooms: number; // with no usage meter: how many rooms may work on their goals at once (0 turns it off)
  usageCommand?: string[]; // optional usage meter: a command printing usage JSON ("{provider}" is replaced by claude or codex)
  remote?: RemoteConfig; // {host: "<mac>.<tailnet>.ts.net", login: "<the owner's Tailscale login>"}; absent = local only
  extraProjects: string[]; // folders always on the project list, wherever they are
  pinnedProjects: string[]; // folders that always get a room on the floor, never the archive cupboard (up to 12)
  hiddenProjects: string[]; // retired folders: no room and no archive entry, even if they still log sessions
  archivedProjects: string[]; // folders kept in the archive cupboard, however busy, until the owner brings them back
  briefingTime?: string; // "HH:MM": when the manager does the daily brief; absent or malformed: no brief
}

export const DEFAULT_CONFIG: Config = {
  officeName: 'Tiny HQ',
  ownerName: 'Owner',
  managerName: 'Manager',
  managerStyle: 'calm',
  projectRoots: ['Dev', 'Developer', 'Projects', 'Sites', 'code', 'src'].map((d) => join(homedir(), d)),
  extras: { github: false, coffee: false, happenings: true },
  goalRooms: 1,
  extraProjects: [],
  pinnedProjects: [],
  hiddenProjects: [],
  archivedProjects: [],
  briefingTime: '08:30',
};

// A short display name: letters, digits, spaces and a few marks; nothing that could steer a prompt.
export const cleanName = (v: unknown, fallback: string): string => {
  const s = typeof v === 'string' ? v.replace(/[^\p{L}\p{N} .'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 32) : '';
  return s || fallback;
};

const paths = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && /^\/[^\x00-\x1f\x7f]{1,400}$/.test(p)).slice(0, 50) : [];

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 });
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    const remote = remoteFrom(raw.remote);
    const extras = (raw.extras ?? {}) as Partial<Config['extras']>;
    const cmd = Array.isArray(raw.usageCommand) && raw.usageCommand.length && raw.usageCommand.every((a) => typeof a === 'string' && a.length < 400) ? raw.usageCommand.slice(0, 20) : undefined;
    const roots = paths(raw.projectRoots);
    return {
      officeName: cleanName(raw.officeName, DEFAULT_CONFIG.officeName),
      ownerName: cleanName(raw.ownerName, DEFAULT_CONFIG.ownerName),
      managerName: cleanName(raw.managerName, DEFAULT_CONFIG.managerName),
      managerStyle: STYLES.includes(raw.managerStyle as ManagerStyle) ? (raw.managerStyle as ManagerStyle) : DEFAULT_CONFIG.managerStyle,
      projectRoots: Array.isArray(raw.projectRoots) ? roots.slice(0, 10) : DEFAULT_CONFIG.projectRoots,
      extras: { github: extras.github === true, coffee: extras.coffee === true, happenings: extras.happenings !== false },
      goalRooms: typeof raw.goalRooms === 'number' && Number.isInteger(raw.goalRooms) ? Math.max(0, Math.min(3, raw.goalRooms)) : DEFAULT_CONFIG.goalRooms,
      ...(cmd ? { usageCommand: cmd } : {}),
      ...(remote ? { remote } : {}),
      extraProjects: paths(raw.extraProjects),
      pinnedProjects: paths(raw.pinnedProjects).slice(0, 12), // the rooms the owner picked; the floor holds 12
      hiddenProjects: paths(raw.hiddenProjects),
      archivedProjects: paths(raw.archivedProjects),
      ...(parseTime(raw.briefingTime) ? { briefingTime: parseTime(raw.briefingTime) } : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Writes the settings atomically, readable only by the owner (the wizard and the settings panel use it).
export function saveConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
