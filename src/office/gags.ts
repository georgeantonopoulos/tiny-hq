// New office happenings, written by a Haiku agent about once a day, so the office keeps a little
// life in it: gags, props and a few stock animations.
// Haiku only writes
// lines and picks prop and move names from the office's kit; the office draws them. Anything
// that doesn't fit the kit is dropped, so a bad answer just means no new gags today.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ANIMS, HAPPENINGS, MANAGER_HAPPENINGS, PROPS, validGag, type Gag } from '../../web/app/whimsy.ts';

export const DAY = 24 * 60 * 60_000;
export const RETRY = 6 * 60 * 60_000; // after a failed write
export const KEEP = 80; // the pool: newest gags first, older ones fall off
const PER_RUN = 10;

export interface GagFile {
  at: number; // when Haiku last wrote some (or last tried, after a failure)
  ok: boolean;
  gags: Gag[];
}

export function loadGags(path: string): GagFile {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<GagFile>;
    const gags = Array.isArray(o.gags) ? o.gags.map(validGag).filter((g): g is Gag => !!g) : [];
    return { at: typeof o.at === 'number' ? o.at : 0, ok: o.ok !== false, gags };
  } catch {
    return { at: 0, ok: true, gags: [] };
  }
}

export function saveGags(path: string, f: GagFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// Time for a new batch: a day after the last one, or six hours after a failed try.
export function gagsDue(f: GagFile, now = Date.now()): boolean {
  return now - f.at >= (f.ok ? DAY : RETRY);
}

// New gags go on top; repeats (same line, any case) are skipped; the pool stays at KEEP.
export function addGags(f: GagFile, fresh: Gag[], now = Date.now()): GagFile {
  const seen = new Set([...HAPPENINGS, ...MANAGER_HAPPENINGS, ...f.gags.map((g) => g.text)].map((t) => t.toLowerCase()));
  const add: Gag[] = [];
  for (const g of fresh) {
    const k = g.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    add.push(g);
  }
  return { at: now, ok: true, gags: [...add, ...f.gags].slice(0, KEEP) };
}

export function gagPrompt(f: GagFile, rnd: () => number = Math.random): string {
  // A handful of what's already there, so the tone carries and nothing repeats.
  const pool = [...HAPPENINGS, ...MANAGER_HAPPENINGS, ...f.gags.map((g) => g.text)];
  const sample = pool.sort(() => rnd() - 0.5).slice(0, 12);
  return [
    `You write tiny comic happenings for a cosy pixel-art office where Claude agents work on projects. Each is one short line (under 120 characters) shown in italics over a character, like a narrator aside. Gentle, dry, absurd office humour; never mean, never about real people, products or news.`,
    `Write ${PER_RUN} NEW ones, different from these:`,
    ...sample.map((t) => `- ${t}`),
    ``,
    `Rules:`,
    `- "who": "anyone" lines must use {name} (the character's first name) or {room} (their room), and no other braces. "who": "manager" lines are about The Manager (write "The Manager"). About 1 in 4 should be manager lines.`,
    `- "prop" (optional): a small item that appears beside them for a while. One of: ${PROPS.join(', ')}. Only when the line mentions it.`,
    `- "anim" (optional): a little move the office plays. One of: ${ANIMS.join(', ')} (spin: their chair spins; hop: a happy hop; plane: a paper plane flies off; cat: a cat strolls past; confetti: a small burst; zzz: a nap; notes: humming; rain: a tiny raincloud over them). Only when it fits the line.`,
    `- Pick a prop or anim only when the line is plainly about it (a duck line gets the duck; a nap gets zzz). Most lines should have one; leave it out rather than force it.`,
    ``,
    `Reply with only a JSON array, nothing else, like:`,
    `[{"text": "{name}'s rubber duck has started a code review.", "who": "anyone", "prop": "duck"}]`,
  ].join('\n');
}

// Haiku's answer (the CLI's JSON envelope, or plain text) to gags that fit the kit.
export function parseGags(out: string): Gag[] {
  let text = out.trim();
  try {
    const o = JSON.parse(text) as { result?: unknown; is_error?: unknown };
    if (o && !Array.isArray(o) && typeof o === 'object') {
      if (o.is_error === true || typeof o.result !== 'string') return [];
      text = o.result.trim();
    }
  } catch {
    /* plain text */
  }
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    return Array.isArray(arr) ? arr.slice(0, PER_RUN * 2).map(validGag).filter((g): g is Gag => !!g) : [];
  } catch {
    return [];
  }
}

export interface WriteOpts {
  claude: string;
  cwd: string; // an empty folder of its own: no project CLAUDE.md, no persona
  env: NodeJS.ProcessEnv;
}

// One Haiku call, no tools: it only writes text.
export function writeGags(f: GagFile, o: WriteOpts): Promise<Gag[]> {
  mkdirSync(o.cwd, { recursive: true, mode: 0o700 });
  const args = ['-p', '--model', 'haiku', '--setting-sources', 'project,local', '--output-format', 'json', '--max-turns', '1', '--tools', '', '--', gagPrompt(f)];
  return new Promise((resolve, reject) => {
    const child = execFile(o.claude, args, { cwd: o.cwd, env: o.env, timeout: 2 * 60_000, killSignal: 'SIGKILL', maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return reject(new Error(`gag writer: ${String(err.message).slice(0, 200)}`));
      const gags = parseGags(out);
      gags.length ? resolve(gags) : reject(new Error(`gag writer gave no usable gags: ${out.slice(0, 200)}`));
    });
    child.stdin?.end();
  });
}
