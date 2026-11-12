// Which Chrome profile holds which sign-in. With several profiles, rooms guess, and a wrong guess
// signs in to the wrong account. Before any web
// console a room checks this list and uses that profile; whenever it finds out which profile
// works for a site, it adds or corrects the line. File: <dataDir>/chrome-profiles.json.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ProfileLine {
  site: string; // e.g. "harbor.com"
  profile: string; // the profile as the owner knows it, e.g. 'Work ("Profile 9")'
  how: string; // how a room reaches it, e.g. 'Claude in Chrome: "Browser 1"' or 'no extension: ...'
  by: string; // who found it out
  at: number;
}

export const profilesPath = (dataDir: string) => join(dataDir, 'chrome-profiles.json');
const clean = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// "https://www.Example.com/x" -> "example.com"
export const siteKey = (s: string) => clean(s, 200).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

export function loadProfiles(path: string): ProfileLine[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ProfileLine[];
    return Array.isArray(raw) ? raw.filter((l) => l && typeof l.site === 'string' && typeof l.profile === 'string') : [];
  } catch {
    return [];
  }
}

export function setProfile(path: string, line: Omit<ProfileLine, 'at'>, now = Date.now()): ProfileLine {
  const l: ProfileLine = { site: siteKey(line.site), profile: clean(line.profile, 80), how: clean(line.how, 200), by: clean(line.by, 60) || 'a room', at: now };
  if (!l.site || !l.profile) throw new Error('a site and a profile are both needed');
  const list = [...loadProfiles(path).filter((x) => x.site !== l.site), l].sort((a, b) => a.site.localeCompare(b.site));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return l;
}

// The line for a site (also matches a sub-site: "play.google.com" finds "play.google.com/console").
export function profileFor(list: ProfileLine[], site: string): ProfileLine | undefined {
  const k = siteKey(site);
  return list.find((l) => l.site === k) ?? list.find((l) => k.endsWith(`.${l.site}`) || l.site.startsWith(`${k}/`) || k.startsWith(`${l.site}/`));
}

export function renderProfiles(list: ProfileLine[]): string {
  if (!list.length) return 'No Chrome profiles noted yet. When you find which profile works for a site, add it: profiles set "<site>" "<profile>" --how "<how to reach it>".';
  return list.map((l) => `${l.site}: ${l.profile} · ${l.how || 'how: not noted'} (noted by ${l.by}, ${new Date(l.at).toISOString().slice(0, 10)})`).join('\n');
}
