// manager/usage: where the Claude usage went, per session folder, measured from the transcripts Claude
// Code saves (their usage fields), not guessed. Measure before you claim a cause or a share.
//   usage                 the last 7 days
//   usage --hours N       the last N hours
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Tally = { calls: number; fresh: number; cacheWrite: number; cacheRead: number; out: number };
// Rough weights relative to fresh input: cache reads are cheap, writes a little dearer, output dear.
export const weight = (t: Tally): number => t.fresh + 1.25 * t.cacheWrite + 0.1 * t.cacheRead + 5 * t.out;

export function roomOfFolder(folder: string): string {
  return folder
    .replace(/^-Users-[^-]+-/, '')
    .replace(/^-Volumes-Macintosh-HD-?Users-[^-]+-/, '')
    .split('--claude-worktrees-')[0]!;
}

type Line = { type?: string; timestamp?: string; requestId?: string; message?: { id?: string; usage?: Record<string, number> } };

export function tallyLines(lines: string[], since: number, seen = new Set<string>(), into: Tally = { calls: 0, fresh: 0, cacheWrite: 0, cacheRead: 0, out: 0 }): Tally {
  for (const l of lines) {
    if (!l.includes('"usage"')) continue;
    let o: Line;
    try {
      o = JSON.parse(l) as Line;
    } catch {
      continue;
    }
    const u = o.message?.usage;
    if (!u || !o.timestamp || Date.parse(o.timestamp) < since) continue;
    const key = `${o.message?.id}|${o.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    into.calls++;
    into.fresh += u.input_tokens ?? 0;
    into.cacheWrite += u.cache_creation_input_tokens ?? 0;
    into.cacheRead += u.cache_read_input_tokens ?? 0;
    into.out += u.output_tokens ?? 0;
  }
  return into;
}

function* jsonl(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonl(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function readAll(p: string): string[] {
  const fd = openSync(p, 'r');
  try {
    const size = statSync(p).size;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

export function measure(since: number, root = join(homedir(), '.claude', 'projects')): Map<string, Tally> {
  const out = new Map<string, Tally>();
  const seen = new Set<string>();
  for (const folder of readdirSync(root)) {
    const dir = join(root, folder);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const room = roomOfFolder(folder);
      for (const f of jsonl(dir)) {
        if (statSync(f).mtimeMs < since) continue;
        out.set(room, tallyLines(readAll(f), since, seen, out.get(room)));
      }
    } catch {
      // a folder that can't be read is skipped
    }
  }
  return out;
}

const isMain = process.argv[1]?.endsWith('usage.ts');
if (isMain) {
  const i = process.argv.indexOf('--hours');
  const since = Date.now() - (i > 0 ? Number(process.argv[i + 1]) : 7 * 24) * 3_600_000;
  const rows = [...measure(since)].map(([room, t]) => ({ room, t, w: weight(t) })).sort((a, b) => b.w - a.w);
  const all = rows.reduce((n, r) => n + r.w, 0) || 1;
  console.log(`Since ${new Date(since).toLocaleString('en-GB')}, from the transcripts (share is weighted: cache re-reads count a tenth).`);
  for (const r of rows.filter((r) => r.w / all >= 0.005))
    console.log(`${r.room.padEnd(34)} ${((100 * r.w) / all).toFixed(1).padStart(5)}%  ${String(r.t.calls).padStart(5)} steps  ${Math.round(r.t.cacheRead / Math.max(r.t.calls, 1) / 1000)}k re-read per step`);
}
