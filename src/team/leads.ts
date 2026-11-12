// Project leads: one named character per office room. Names already hired are
// kept in ~/.tiny-hq/leads.json so they stick; new rooms get a name from
// a fixed list (no model call). The character stands for that folder's Claude session.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Project } from '../discovery/scan.ts';

export interface Palette {
  skin: string;
  hair: string;
  shirt: string;
}

export interface Lead {
  projectId: string;
  projectPath: string;
  name: string;
  personality: string;
  palette: Palette;
  hiredAt: number;
}

// Keyed by the project's folder path, which never changes. Room ids can (two
// folders with the same name swap "app" and "app-2" when their activity flips),
// so they must never decide who leads what.
export type Leads = Record<string, Lead>;

export const leadFor = (leads: Leads, p: { path: string }): Lead | undefined => leads[p.path];

const SKINS = ['#f1c8a5', '#e8b48f', '#c98e64', '#a86f47', '#7a4c2e', '#f5d6c0'];
const HAIRS = ['#2b2024', '#6b4a2f', '#b5653a', '#d9b45b', '#8c8c94', '#3b2a4f', '#c94f6d'];
const SHIRTS = ['#c0504d', '#4f9a5c', '#e0a23b', '#7a5cc2', '#3a9bb5', '#d0662f', '#5c7a99', '#b0487f'];

// A stable look per lead, from their name: same person, same outfit, every day.
export function paletteFor(seed: string): Palette {
  const h = createHash('sha256').update(seed).digest();
  return { skin: SKINS[h[0]! % SKINS.length]!, hair: HAIRS[h[1]! % HAIRS.length]!, shirt: SHIRTS[h[2]! % SHIRTS.length]! };
}

export function loadLeads(path: string): Leads {
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    // Keep only well-formed entries; a hand-edited file can't break the office.
    const out: Leads = {};
    for (const [key, l] of Object.entries(raw as Record<string, Partial<Lead>>)) {
      if (!l || typeof l.name !== 'string' || typeof l.personality !== 'string' || typeof l.projectId !== 'string') continue;
      // Files written before path keys used the room id as the key.
      const path = typeof l.projectPath === 'string' && l.projectPath.startsWith('/') ? l.projectPath : key.startsWith('/') ? key : '';
      if (!path) continue;
      const pal = l.palette;
      const okPalette = pal && [pal.skin, pal.hair, pal.shirt].every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));
      out[path] = {
        projectId: l.projectId,
        projectPath: path,
        name: clean(l.name, 40),
        personality: clean(l.personality, 160),
        palette: okPalette ? pal : paletteFor(l.name),
        hiredAt: typeof l.hiredAt === 'number' ? l.hiredAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLeads(path: string, leads: Leads): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(leads, null, 2) + '\n', { mode: 0o600 });
}

export interface Hire {
  projectId: string;
  name: string;
  personality: string;
}

export type Recruiter = (projects: Project[]) => Promise<Hire[]>;

// Names are shown in the office: keep them short and plain.
const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f<>`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Names for new leads, in turn.
const FALLBACK = [
  ['Pixel Pip', 'Counts every frame twice and trusts neither count.'],
  ['Merge Margaret', 'Has never met a conflict they could not resolve with tea.'],
  ['Deadline Dave', 'Calm on the outside, 14 browser tabs on the inside.'],
  ['Refactor Rhona', 'Leaves every file slightly tidier than they found it.'],
  ['Hotfix Harry', 'Lives on the edge of production and likes the view.'],
  ['Release Rosa', 'Writes release notes nobody reads, beautifully.'],
  ['Compile Colin', 'Believes every warning is a cry for help.'],
  ['Backlog Bev', 'Knows where every ticket is buried.'],
] as const;

// The manager's first name stays theirs.
export const RESERVED_FIRST_NAMES = ['manager'];
const first = (name: string) => name.trim().split(/\s+/)[0]!.toLowerCase();

export function fallbackHires(projects: Project[], taken: Set<string>): Hire[] {
  return projects.map(() => {
    // The first name on the list nobody has yet (by full name or first name); once all are used, numbered.
    const firsts = new Set([...taken].map(first));
    const free = FALLBACK.find(([n]) => !taken.has(n) && !firsts.has(first(n)));
    const [base, personality] = free ?? FALLBACK[taken.size % FALLBACK.length]!;
    let name: string = base;
    let n = 2;
    while (taken.has(name)) name = `${base} ${n++}`;
    taken.add(name);
    return { name, personality };
  }).map((h, i) => ({ projectId: projects[i]!.id, ...h }));
}

// Names leads for projects that don't have one. Never throws: if the recruiter
// fails (or there is none), everyone new gets a name from the list.
export async function staffRooms(projects: Project[], leads: Leads, recruit: Recruiter = async () => [], now = Date.now()): Promise<{ leads: Leads; hired: Lead[] }> {
  const missing = projects.filter((p) => !leadFor(leads, p));
  if (!missing.length) return { leads, hired: [] };
  const taken = new Set(Object.values(leads).map((l) => l.name));
  // First names already in the office: each name means one person.
  const firstNames = new Set([...Object.values(leads).map((l) => first(l.name)), ...RESERVED_FIRST_NAMES]);
  let hires: Hire[];
  try {
    hires = await recruit(missing);
  } catch {
    hires = [];
  }
  // Keep a model-given name only if it's complete, for a project we asked
  // about, and not already somebody else's (in the office or in this batch).
  const wanted = new Set(missing.map((p) => p.id));
  const byId = new Map<string, Hire>();
  for (const h of hires) {
    if (!h.name || !h.personality || !wanted.has(h.projectId) || byId.has(h.projectId) || taken.has(h.name) || firstNames.has(first(h.name))) continue;
    taken.add(h.name);
    firstNames.add(first(h.name));
    byId.set(h.projectId, h);
  }
  const unnamed = missing.filter((p) => !byId.has(p.id));
  for (const h of fallbackHires(unnamed, taken)) byId.set(h.projectId, h);
  const next: Leads = { ...leads };
  const hired: Lead[] = [];
  for (const p of missing) {
    const h = byId.get(p.id)!;
    const lead: Lead = { projectId: p.id, projectPath: p.path, name: h.name, personality: h.personality, palette: paletteFor(h.name), hiredAt: now };
    next[p.path] = lead;
    hired.push(lead);
  }
  return { leads: next, hired };
}

// ---- Name tags: each room's worker learns its name ----
// A tag holds only who they are and what they do, nothing that changes how they work. The office
// keeps them in its own folder, <dataDir>/tags/<project folder, as Claude Code names it>.md, and
// hooks/office-name.sh reads only from there (never the
// project's own .claude/office.md: a cloned repo could ship one and steer every session started
// in it). Written once if missing and never overwritten (the owner may edit it).
export const NAME_TAG = join('.claude', 'office.md'); // where tags used to live, inside each project
// Byte by byte, so the hook (sh, `LC_ALL=C sed`) works out the same name for folders with
// accents or emoji (one "-" per UTF-8 byte that isn't a letter or digit).
export const tagKey = (folder: string) => Array.from(Buffer.from(folder, 'utf8'), (b) => (/[a-zA-Z0-9]/.test(String.fromCharCode(b)) && b < 128 ? String.fromCharCode(b) : '-')).join('');
export const tagFile = (tagsDir: string, folder: string) => join(tagsDir, `${tagKey(folder)}.md`);
export function nameTag(name: string, room: string, folder: string, who: { owner?: string; manager?: string } = {}): string {
  const plain = (t: string) => t.replace(/[\x00-\x1f\x7f<>`{}*_#[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const n = plain(name);
  const owner = who.owner ? plain(who.owner) : 'the owner';
  const manager = who.manager ? plain(who.manager) : 'the manager';
  return [
    `# Your name in ${who.owner ? `${owner}'s` : "the owner's"} office`,
    '',
    `You are ${n}, the person at the desk of the ${plain(room)} room. You work on this project (${plain(folder)}) for ${owner}. ${manager[0]!.toUpperCase() + manager.slice(1)} is your manager.`,
    '',
    `Sign anything you send the manager or another room with "${n}:". This is only your name tag: it doesn't change how you work.`,
    '',
  ].join('\n');
}

// Writes the room's tag into the office's own folder if it has none. Nothing is ever read from the
// project: a heading check could
// be faked by a cloned repo. True when written.
export function writeNameTag(folder: string, name: string, room: string, tagsDir: string, who: { owner?: string; manager?: string } = {}): boolean {
  const file = tagFile(tagsDir, folder);
  if (!existsSync(folder) || existsSync(file)) return false;
  mkdirSync(tagsDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, nameTag(name, room, folder, who), { flag: 'wx', mode: 0o600 });
  return true;
}
