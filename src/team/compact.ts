// Long conversations: every step re-reads the whole conversation, so a session at 500k
// tokens costs 2.5 times one at 200k for the same work. Fresh sessions summarise at 200k
// (autoCompactWindow in each room's settings), but a session that was already running, or
// was resumed, keeps the limit it started with, so the setting alone never reaches it.
// So the office types /compact into a quiet session whose conversation has grown past the line.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMPACT_OVER = 250_000; // tokens in the last step's context
export const QUIET_MS = 5 * 60_000; // untouched this long before the office steps in
export const AGAIN_MS = 60 * 60_000; // at most once an hour per session
const TAIL = 2 * 1024 * 1024;

type Rec = { type?: string; subtype?: string; isSidechain?: boolean; message?: { usage?: Record<string, number> } };

// Tokens the session's last step read (its whole conversation), or 0 after a summary.
export function contextFrom(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    let r: Rec;
    try {
      r = JSON.parse(lines[i] ?? '');
    } catch {
      continue;
    }
    if (r.type === 'system' && r.subtype === 'compact_boundary') return 0;
    if (r.type !== 'assistant' || r.isSidechain) continue;
    const u = r.message?.usage;
    if (!u) continue;
    return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return 0;
}

export function contextSize(transcript: string): number {
  let fd: number;
  try {
    fd = openSync(transcript, 'r');
  } catch {
    return 0;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return contextFrom(buf.toString('utf8').split('\n'));
  } finally {
    closeSync(fd);
  }
}

export function shouldCompact(o: { tokens: number; quietFor: number; askedAt?: number; now: number }): boolean {
  return o.tokens > COMPACT_OVER && o.quietFor >= QUIET_MS && (o.askedAt === undefined || o.now - o.askedAt >= AGAIN_MS);
}

// When the office last asked each session to summarise.
export const compactPath = (dataDir: string): string => join(dataDir, 'compact.json');
export function loadCompacts(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}
export function saveCompacts(path: string, all: Record<string, number>, now: number): void {
  const keep = Object.fromEntries(Object.entries(all).filter(([, at]) => now - at < 7 * 24 * 3600_000));
  writeFileSync(path, JSON.stringify(keep, null, 2));
}
