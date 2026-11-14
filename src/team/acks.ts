// After the owner clicks a button, the room must visibly take it up. A click can land in a session that
// only answers "Please run /login · API Error", and nobody would hear. So the office notes each answer
// it types into a session and watches that session's transcript: a reply (anything it writes or does)
// is the acknowledgement; an API or sign-in error, or silence past ACK_MS, means it wasn't picked up,
// and the manager is told.
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const ACK_MS = 90_000;
const GIVE_UP_MS = 30 * 60_000; // a check that can't be read for this long is dropped

// `why`: it wasn't picked up, and the manager hasn't been told yet (kept until they are).
// `shownAt`: when the answer first showed in its chat, kept so a transcript read that no longer reaches
// back that far still knows.
export type PendingAck = { sessionId: string; cwd: string; room: string; question: string; answer: string; at: number; why?: string; shownAt?: number };
export type AckResult = { status: 'ok' } | { status: 'wait'; shownAt?: number } | { status: 'failed'; why: string };

export const acksPath = (notesDir: string): string => join(notesDir, 'acks.json');

export function loadAcks(path: string): PendingAck[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { acks?: unknown };
    return (Array.isArray(raw.acks) ? raw.acks : []).filter(
      (a): a is PendingAck => !!a && typeof a === 'object' && typeof (a as PendingAck).sessionId === 'string' && typeof (a as PendingAck).cwd === 'string' && typeof (a as PendingAck).at === 'number',
    );
  } catch {
    return [];
  }
}

export function saveAcks(path: string, acks: PendingAck[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ acks: acks.slice(-50) }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function addAck(path: string, a: PendingAck): void {
  // A newer answer to the same question replaces the watch on the older one, but never a miss the
  // manager hasn't been told about yet.
  saveAcks(path, [...loadAcks(path).filter((x) => x.why || !(x.sessionId === a.sessionId && x.question === a.question)), a]);
}

// What Claude Code writes in place of a reply when it can't reach the model or isn't signed in.
const BROKEN = /API Error|Please run \/login|Invalid API key|OAuth token has expired|Credit balance is too low|usage limit reached|overloaded_error/i;

export type Records = Rec[] & { clipped?: boolean }; // clipped: only the tail of a longer transcript
type Rec = { type?: string; timestamp?: string; isSidechain?: boolean; isApiErrorMessage?: boolean; message?: { content?: unknown }; attachment?: { type?: string; prompt?: unknown } };

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c?.type === 'text' ? (c.text ?? '') : '')).join(' ') : '';
const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

// Did the session take it up? Only what it did after the answer itself shows in its chat counts: a
// busy room takes a typed answer later, and its work on the task before is not an acknowledgement.
// Silence is timed from when the answer showed; an answer that never shows fails after GIVE_UP_MS.
export function ackFrom(records: Records, at: number, now = Date.now(), answer = '', seen?: number): AckResult {
  const key = squash(answer).slice(0, 60);
  let from = -1;
  let shownAt = seen ?? at;
  // Seen before: everything the session wrote from then on counts, even once the answer itself is
  // older than what the transcript read reaches.
  if (seen !== undefined) from = records.findIndex((r) => !!r.timestamp && Date.parse(r.timestamp) >= seen) - 1;
  if (seen !== undefined && from < -1) from = records.length - 1; // nothing new yet
  for (let i = 0; seen === undefined && i < records.length; i++) {
    const r = records[i]!;
    if (r.isSidechain || !r.timestamp || Date.parse(r.timestamp) < at - 2_000) continue;
    // A busy session gets a typed answer mid-turn as a queued command, not as a user message.
    const text = r.type === 'user' ? textOf(r.message?.content) : r.type === 'attachment' && r.attachment?.type === 'queued_command' ? textOf(r.attachment.prompt) : undefined;
    if (text === undefined) continue;
    if (!key || squash(text).includes(key)) {
      from = i;
      shownAt = Date.parse(r.timestamp);
      break;
    }
  }
  // The answer is older than the part of the transcript read (only its tail is), and the session has
  // written since: it took it up. This happens when a session moves into a worktree right after the
  // owner's click: the watch loses its transcript for a while, and by the time it finds it again the
  // answer has scrolled out of the tail. Its replies are then judged from the start of what was read,
  // with the same checks as any reply, so a sign-in or API error still fails.
  const first = records.find((r) => !!r.timestamp);
  const scrolledOut = from < 0 && seen === undefined && !!records.clipped && !!first && Date.parse(first.timestamp!) > at;
  if (from < 0 && seen === undefined && !scrolledOut) return now - at >= GIVE_UP_MS ? { status: 'failed', why: `the answer never showed up in its chat in the ${Math.round((now - at) / 60_000)} minutes since` } : { status: 'wait' };
  for (const r of records.slice(from + 1)) {
    if (r.type !== 'assistant' || r.isSidechain) continue;
    const content = Array.isArray(r.message?.content) ? (r.message!.content as { type?: string; text?: string }[]) : [];
    const text = content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join(' ').trim();
    if (r.isApiErrorMessage || (BROKEN.test(text) && text.length < 300)) return { status: 'failed', why: `it only answered "${text.slice(0, 120)}"` };
    if (text || content.some((c) => c?.type === 'tool_use')) return { status: 'ok' };
  }
  return now - shownAt >= ACK_MS ? { status: 'failed', why: `it hasn't written or done anything in the ${Math.round((now - shownAt) / 1000)} s since it got the answer` } : { status: 'wait', shownAt };
}

// Where the session's transcript is now. Claude Code moves it to the worktree's folder while the
// session works in a worktree (and back after), so the folder of the cwd it had when the owner clicked
// isn't enough: the newest copy of <sessionId>.jsonl under ~/.claude/projects wins.
export function transcriptFile(sessionId: string, cwd: string, home = homedir()): string | undefined {
  const projects = join(home, '.claude', 'projects');
  const name = `${sessionId}.jsonl`;
  const dirs = [cwd.replace(/[^a-zA-Z0-9]/g, '-')];
  try {
    dirs.push(...readdirSync(projects));
  } catch {
    // no projects folder
  }
  let best: { file: string; at: number } | undefined;
  for (const d of new Set(dirs)) {
    const file = join(projects, d, name);
    try {
      const at = statSync(file).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    } catch {
      // not in this folder
    }
  }
  return best?.file;
}

export function transcriptRecords(sessionId: string, cwd: string, home = homedir()): Records | undefined {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return undefined;
  const file = transcriptFile(sessionId, cwd, home);
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const recs: Records = buf
      .toString('utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Rec];
        } catch {
          return [];
        }
      });
    recs.clipped = size > len;
    return recs;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The office's check: returns the answers that weren't picked up and the manager hasn't been told
// about yet. They stay in the file, and come back on every check, until ackTold says the manager has
// them; taken-up ones are dropped.
export function checkAcks(path: string, now = Date.now(), read = transcriptRecords, onOk: (a: PendingAck) => void = () => undefined): (PendingAck & { why: string })[] {
  const failed: (PendingAck & { why: string })[] = [];
  const keep: PendingAck[] = [];
  for (const a of loadAcks(path)) {
    if (a.why) {
      keep.push(a);
      failed.push({ ...a, why: a.why });
      continue;
    }
    const recs = read(a.sessionId, a.cwd);
    if (!recs) {
      if (now - a.at < GIVE_UP_MS) keep.push(a);
      continue;
    }
    const r = ackFrom(recs, a.at, now, a.answer, a.shownAt);
    if (r.status === 'wait') keep.push(r.shownAt !== undefined ? { ...a, shownAt: r.shownAt } : a);
    else if (r.status === 'failed') {
      keep.push({ ...a, why: r.why });
      failed.push({ ...a, why: r.why });
    } else onOk(a);
  }
  saveAcks(path, keep);
  return failed;
}

// The manager has been told about this miss: stop reporting it.
export function ackTold(path: string, a: Pick<PendingAck, 'sessionId' | 'question' | 'at'>): void {
  saveAcks(path, loadAcks(path).filter((x) => !(x.sessionId === a.sessionId && x.question === a.question && x.at === a.at)));
}
