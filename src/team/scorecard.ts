// The office's scorecard: how the last 24 hours went, so every change to the office can
// be judged by numbers (before/after) instead of by feel. Shown at the top of the manager's
// whiteboard and on their status page. Read from files the office already keeps; no tokens.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from './jobs.ts';

export interface Score {
  jobsDone: number;
  medianMinutes?: number; // ask to done, for those jobs
  asks: number; // buttons put to the owner
  managerWakes: number;
  managerQuiet: number;
  managerTokensM: number; // millions of tokens the manager read
  checksQuiet: number; // timed checks the checker handled without waking the manager
  checksToManager: number;
  goalSteps: number;
}

const DAY = 86_400_000;

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function jobsScore(jobs: Job[], now: number): { jobsDone: number; medianMinutes?: number } {
  const done = jobs.filter((j) => j.status === 'done' && now - j.updatedAt < DAY);
  const m = median(done.map((j) => (j.updatedAt - j.createdAt) / 60_000));
  return { jobsDone: done.length, ...(m !== undefined ? { medianMinutes: Math.round(m) } : {}) };
}

export function jsonl<T>(path: string): T[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          return l ? [JSON.parse(l) as T] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// The manager's conversation files: what woke them (anything typed into their chat: the owner, a room,
// the office), how many of those they answered "(quiet)", and how much they read doing it.
// Each file is read once and then only its new lines (they grow to tens of MB).
type Ev = { at: number; wake?: 1; quiet?: 1; tokens: number };
const seen = new Map<string, { offset: number; events: Ev[] }>();

function eventsOf(line: string): Ev | undefined {
  if (!line.includes('"timestamp"')) return undefined;
  let o: { type?: string; timestamp?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown; usage?: Record<string, number> } };
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  const at = Date.parse(o.timestamp ?? '');
  if (!Number.isFinite(at) || o.isSidechain) return undefined;
  const c = o.message?.content;
  if (o.type === 'user' && !o.isMeta) {
    const isResult = Array.isArray(c) && c.some((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'tool_result');
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x as { text?: string })?.text ?? '').join('') : '';
    return !isResult && text.trim() ? { at, wake: 1, tokens: 0 } : undefined;
  }
  if (o.type === 'assistant') {
    const u = o.message?.usage ?? {};
    const quiet = Array.isArray(c) && c.some((x) => (x as { type?: string; text?: string })?.type === 'text' && (x as { text?: string }).text?.trim() === '(quiet)');
    return { at, tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), ...(quiet ? { quiet: 1 as const } : {}) };
  }
  return undefined;
}

export function managerScore(transcriptDir: string, now: number): { managerWakes: number; managerQuiet: number; managerTokensM: number } {
  let wakes = 0;
  let quiet = 0;
  let tokens = 0;
  if (!existsSync(transcriptDir)) return { managerWakes: 0, managerQuiet: 0, managerTokensM: 0 };
  for (const f of readdirSync(transcriptDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = join(transcriptDir, f);
    let size = 0;
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > DAY) {
        seen.delete(p);
        continue;
      }
      size = st.size;
    } catch {
      continue;
    }
    let entry = seen.get(p);
    if (!entry || size < entry.offset) entry = { offset: 0, events: [] }; // new, or rewritten
    if (size > entry.offset) {
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(size - entry.offset);
        readSync(fd, buf, 0, buf.length, entry.offset);
        const text = buf.toString('utf8');
        const end = text.lastIndexOf('\n'); // only whole lines; the rest next time
        if (end >= 0) {
          for (const line of text.slice(0, end).split('\n')) {
            const ev = eventsOf(line);
            if (ev) entry.events.push(ev);
          }
          entry.offset += Buffer.byteLength(text.slice(0, end + 1));
        }
      } finally {
        closeSync(fd);
      }
    }
    entry.events = entry.events.filter((e) => now - e.at < DAY);
    seen.set(p, entry);
    for (const e of entry.events) {
      wakes += e.wake ?? 0;
      quiet += e.quiet ?? 0;
      tokens += e.tokens;
    }
  }
  return { managerWakes: wakes, managerQuiet: quiet, managerTokensM: Math.round(tokens / 1e5) / 10 };
}

export function score(o: { jobs: Job[]; asksLog: string; checksLog: string; stepsLog: string; managerDir: string; now: number }): Score {
  const since = o.now - DAY;
  const checks = jsonl<{ at: number; kind: string }>(o.checksLog).filter((c) => c.at >= since);
  return {
    ...jobsScore(o.jobs, o.now),
    asks: jsonl<{ at: number }>(o.asksLog).filter((a) => a.at >= since).length,
    ...managerScore(o.managerDir, o.now),
    checksQuiet: checks.filter((c) => c.kind === 'quiet').length,
    checksToManager: checks.filter((c) => c.kind !== 'quiet').length,
    goalSteps: jsonl<{ at: number }>(o.stepsLog).filter((s) => s.at >= since).length,
  };
}

// Plain lines for the whiteboard and the status page.
export function describeScore(s: Score): string[] {
  return [
    `Jobs done: ${s.jobsDone}${s.medianMinutes !== undefined ? ` (median ${s.medianMinutes} min from ask to done)` : ''} · goal steps started on their own: ${s.goalSteps}`,
    `Questions put to the owner: ${s.asks}`,
    `The manager woken ${s.managerWakes} times (${s.managerQuiet} with nothing to say), read ${s.managerTokensM}M tokens`,
    `Timed checks: ${s.checksQuiet} handled quietly by the checker, ${s.checksToManager} passed to the manager`,
  ];
}
