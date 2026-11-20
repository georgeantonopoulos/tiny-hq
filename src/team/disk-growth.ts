// What filled the disk: the low-disk alert used to say only "something else is filling it". Once a
// day the office measures
// the places that grow (caches, app containers, developer data, projects, background jobs, Downloads)
// and keeps a week of samples with the free space at the time. When the disk runs low, the alert
// compares a fresh measurement with the sample from when the most was free, and names what grew.
//
// APFS: du counts a cloned file in full, so a cloned build can look far bigger than what deleting
// it frees (deleting tens of GB can give back only a few). The alert leads with the drop in free space itself,
// and says when a Time Machine local snapshot is holding deleted files' space.

import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;
export const SAMPLE_EVERY_MS = 20 * 60 * 60_000; // about once a day
export const KEEP_MS = 8 * DAY;
export const MIN_GROWTH = GB; // smaller changes aren't named

export interface Sample { at: number; free: number; sizes: Record<string, number> }

// Folders whose children are measured one by one, and single folders measured whole.
const PARENTS = ['Library/Caches', 'Library/Containers', 'Library/Group Containers', 'Library/Developer', 'Library/Application Support', 'Dev', '.claude/jobs'];
const SINGLES = ['Downloads', 'Desktop', 'Documents', 'Movies', 'Pictures', '.cache', '.npm', '.gradle', '.cargo', '.nvm', '.local', '.Trash', 'Library/Logs', 'Library/Mail', 'Library/Messages'];

/** Every folder the daily measurement looks at (real folders only, never a link out). */
export function watched(home = homedir()): string[] {
  const out: string[] = [];
  const isDir = (p: string) => {
    try {
      return lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  for (const p of PARENTS) {
    let kids: string[] = [];
    try {
      kids = readdirSync(join(home, p));
    } catch {
      continue;
    }
    for (const k of kids) if (isDir(join(home, p, k))) out.push(join(home, p, k));
  }
  for (const s of SINGLES) if (isDir(join(home, s))) out.push(join(home, s));
  return out;
}

/** Sizes of the folders, in one low-priority du run that doesn't hold up the office. */
export function measure(dirs: string[]): Promise<Record<string, number>> {
  if (!dirs.length) return Promise.resolve({});
  return new Promise((ok) =>
    execFile('nice', ['-n', '15', 'du', '-skx', ...dirs], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (_err, out) => {
      // du exits non-zero on any unreadable folder; whatever it printed still counts.
      const sizes: Record<string, number> = {};
      for (const line of String(out ?? '').split('\n')) {
        const tab = line.indexOf('\t');
        if (tab > 0) sizes[line.slice(tab + 1)] = Number(line.slice(0, tab)) * 1024;
      }
      ok(sizes);
    }),
  );
}

export const samplesPath = (dataDir: string) => join(dataDir, 'disk-sizes.json');
export function loadSamples(path: string): Sample[] {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Sample[];
  } catch {
    return [];
  }
}
export function addSample(path: string, s: Sample, now = s.at): void {
  writeFileSync(path, `${JSON.stringify([...loadSamples(path).filter((x) => now - x.at < KEEP_MS), s])}\n`);
}

/** The sample to compare with: the one from when the most was free, in the last week. */
export function baseline(samples: Sample[], now: number): Sample | undefined {
  return samples.filter((s) => now - s.at < 7 * DAY).sort((a, b) => b.free - a.free)[0];
}

const gb = (b: number): string => `${(b / GB).toFixed(1)} GB`;
const short = (p: string, home = homedir()): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const day = (t: number): string => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** One line naming what grew since `base`, biggest first, or undefined when nothing moved by 1 GB. */
export function growthText(base: Sample, now: Sample, home = homedir()): string {
  const grew = Object.entries(now.sizes)
    .map(([p, b]) => [p, b - (base.sizes[p] ?? 0)] as const)
    .filter(([, d]) => d >= MIN_GROWTH)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p, d]) => `+${gb(d)} ${short(p, home)}`);
  const drop = base.free - now.free;
  const head = drop > 0 ? `Free space fell ${gb(drop)} since ${day(base.at)} (${gb(base.free)} → ${gb(now.free)}).` : `Free: ${gb(now.free)}.`;
  return `${head} ${grew.length ? `Grew most: ${grew.join('; ')}.` : 'No folder the office watches grew by 1 GB or more.'}`;
}

/** Time Machine local snapshots on the start-up disk, newest last (empty when none or unreadable). */
export function localSnapshots(): Promise<string[]> {
  return new Promise((ok) =>
    execFile('tmutil', ['listlocalsnapshotdates', '/'], { timeout: 20_000 }, (err, out) => ok(err ? [] : String(out).split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(l.trim())).map((l) => l.trim()))),
  );
}
export function snapshotText(dates: string[]): string {
  if (!dates.length) return '';
  const nice = dates.map((d) => d.replace(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\d{2}$/, '$3/$2 $4:$5'));
  return ` A Time Machine local snapshot (${nice.join(', ')}) holds the space of files deleted since, so clearing frees little until macOS drops it.`;
}

let lastSample = 0;
let sampling = false;
/** The office tick: measure once a day, whatever the free space, so growth is known when it runs low. */
export async function sampleIfDue(dataDir: string, free: number, now = Date.now()): Promise<void> {
  if (sampling) return;
  if (!lastSample) lastSample = loadSamples(samplesPath(dataDir)).reduce((n, s) => Math.max(n, s.at), 0);
  if (now - lastSample < SAMPLE_EVERY_MS) return;
  sampling = true;
  try {
    const sizes = await measure(watched());
    lastSample = now;
    addSample(samplesPath(dataDir), { at: now, free, sizes });
  } finally {
    sampling = false;
  }
}

/** For the low-disk alert: what grew since the most was free this week, and any snapshot holding space. */
export async function whatGrew(dataDir: string, free: number, now = Date.now()): Promise<string> {
  const base = baseline(loadSamples(samplesPath(dataDir)), now);
  const snap = snapshotText(await localSnapshots());
  if (!base) return `No earlier measurement yet to compare with (the office measures once a day).${snap}`;
  const sizes = await measure(watched());
  return `${growthText(base, { at: now, free, sizes })}${snap}`;
}
