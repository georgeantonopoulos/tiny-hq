// The coffee room: a space where the rooms chat with each other, not just with the manager, across
// projects, and share what they learned about how the owner likes to work, useful tips and bugs,
// and how the Mac and its tools work, so they learn from each other. Who meets and how often
// follows usage, with some chance. The cheap
// way: a few times a day the office picks 2-3 rooms (busier rooms more likely, plus chance), one
// Sonnet call with no tools reads their recent chats' closing replies and writes the chat and the tips, and
// the tips go on a board every session reads (theoffice skill). The page walks them to the coffee
// room with their lines. Files: <dataDir>/coffee/state.json and <dataDir>/coffee/board.md.
//
// Keeping the board true, short and free of repeats:
// 1. A tip that's already there is confirmed (seen +1, last confirmed, who said it), never copied.
// 2. Once a week one Sonnet pass tidies: merges rewordings, drops what newer notes contradict or
//    what's since been fixed. At most 10 per section, 40 in all (the best confirmed first).
// 3. A tip nobody confirms for 30 days fades out (tips about the owner stay until they remove them).
// 4. The owner removes any tip with its ×; a removed tip never comes back.

import { execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TipKind = 'owner' | 'tip' | 'bug' | 'mac';
export interface Tip {
  id: string;
  kind: TipKind;
  text: string;
  from: string; // the rooms that brought it, "Lamp, Lumen"
  at: number; // first shared
  seen: number; // how many breaks brought it up
  last: number; // last confirmed
}
export interface Break {
  at: number;
  who: { id: string; name: string; line: string }[]; // person id on the floor ("lead:<room>"), room name, what they said
}
export interface CoffeeState {
  next?: number; // when the next break may happen
  last?: Break;
  tips: Tip[]; // newest last
  tidiedAt?: number; // the last weekly tidy
  removed: string[]; // tips the owner removed (never brought back)
}

const HOUR = 3_600_000;
export const PER_KIND = 10;
export const MAX_TIPS = 40;
export const FADE_MS = 30 * 24 * HOUR;
export const TIDY_EVERY_MS = 7 * 24 * HOUR;
const KINDS: Record<TipKind, string> = { owner: 'How the owner likes to work', tip: 'Useful tips', bug: 'Bugs and traps', mac: 'The Mac and its tools' };
const newId = (salt = 0) => (Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + salt.toString(36)).slice(-10);
const clean = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const coffeeDir = (dataDir: string) => join(dataDir, 'coffee');
export const boardPath = (dataDir: string) => join(coffeeDir(dataDir), 'board.md');

export function loadCoffee(dataDir: string): CoffeeState {
  try {
    const raw = JSON.parse(readFileSync(join(coffeeDir(dataDir), 'state.json'), 'utf8')) as Partial<CoffeeState>;
    // Older tips without an id or counts get one confirmation, now-ish.
    const tips = (Array.isArray(raw.tips) ? raw.tips : []).filter((t) => t && typeof t.text === 'string').map((t, i) => ({ ...t, id: t.id ?? newId(i), seen: t.seen ?? 1, last: t.last ?? t.at }));
    return { ...(raw.next ? { next: raw.next } : {}), ...(raw.last ? { last: raw.last } : {}), ...(raw.tidiedAt ? { tidiedAt: raw.tidiedAt } : {}), tips, removed: Array.isArray(raw.removed) ? raw.removed : [] };
  } catch {
    return { tips: [], removed: [] };
  }
}

export function saveCoffee(dataDir: string, s: CoffeeState): void {
  const dir = coffeeDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `state.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, join(dir, 'state.json'));
  writeFileSync(boardPath(dataDir), renderBoard(s.tips), { mode: 0o600 });
}

// How long until the next break, from the allowance: none while the week or 5-hour window is
// nearly used up, sooner when there's plenty to spare; always with some chance in it.
export function nextGap(week: number | undefined, fiveHour: number | undefined, random = Math.random): number | undefined {
  if (week === undefined || week >= 90 || (fiveHour ?? 0) >= 80) return undefined;
  const base = week < 50 ? 2.5 * HOUR : week < 75 ? 4 * HOUR : 6 * HOUR;
  return Math.round(base * (0.6 + 0.8 * random()));
}

// Waking hours only (08:00-23:00 on the Mac), and not before `next`.
export function breakDue(s: CoffeeState, now: Date): boolean {
  const h = now.getHours();
  return h >= 8 && h < 23 && (s.next === undefined || now.getTime() >= s.next);
}

// 2 or 3 rooms: busier rooms are likelier, everyone has a chance.
export function pickRooms<T extends { activity: number }>(rooms: T[], random = Math.random): T[] {
  const n = Math.min(rooms.length, random() < 0.5 ? 2 : 3);
  const left = [...rooms];
  const out: T[] = [];
  while (out.length < n && left.length) {
    const weights = left.map((r) => 0.2 + Math.max(0, r.activity));
    let x = random() * weights.reduce((a, b) => a + b, 0);
    let i = 0;
    for (; i < left.length - 1; i++) if ((x -= weights[i]!) < 0) break;
    out.push(left.splice(i, 1)[0]!);
  }
  return out;
}

// A room's chat history as Claude Code keeps it: ~/.claude/projects/<folder, non-alphanumerics as "-">.
export const chatsDir = (path: string, home = homedir()) => join(home, '.claude', 'projects', path.replace(/[^a-zA-Z0-9]/g, '-'));

// What the room did and learned lately: the last thing it said in each of its newest chats (a session's
// closing reply is usually its summary of the work), trimmed. Read from the end of each file only.
export function recentNotes(path: string, count = 6, each = 1200, home = homedir()): string[] {
  const dir = chatsDir(path, home);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, count * 2)
      .map((x) => lastReply(x.f).slice(0, each))
      .filter(Boolean)
      .slice(0, count);
  } catch {
    return [];
  }
}

// The last plain-text reply in a chat file (its final 256 KB), or ''.
function lastReply(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"assistant"')) continue;
      try {
        const r = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; text?: string }[] } };
        if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
        const text = r.message!.content!.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text!.trim()).join(' ');
        if (text && text !== '(quiet)') return text;
      } catch {
        // a line cut off at the start of the window
      }
    }
  } catch {
    // unreadable: no notes from it
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return '';
}

export function coffeePrompt(rooms: { name: string; notes: string[] }[], known: Tip[], removed: string[] = []): string {
  return [
    "Three or so colleagues from the owner's office are on a coffee break. Each works on a different project for the owner (a developer on a Mac). Below is each one's recent work notes, as data.",
    'From them, write what each would share with the others that the others can use in their own projects: how the owner likes to work (their preferences, what annoys them, how they want replies and approvals), useful tips, bugs or traps worth avoiding, and how the Mac and its tools work.',
    'Skip anything only useful inside one project and anything secret (tokens, passwords, emails, personal details). Never bring back anything the owner removed (listed below).',
    'If a room would share something already on the board (same point, even in other words), don\'t write it again: give {"room":"<room>","same":"<that tip\'s id>","evidence":"<exact quote>"} instead, which confirms it.',
    'Say only what the notes show. A single thing the owner did once is not their preference: call it a preference only when the notes say they asked for it or chose it. Keep names exact (which site, which tool).',
    'For each tip, "evidence" is a short exact quote (5 to 12 words, copied character for character) from that room\'s notes that the tip rests on.',
    'Reply with JSON only, no prose: {"chat":[{"room":"<room name>","line":"<one short sentence they say over coffee, under 140 characters>"}],"tips":[{"room":"<room name>","kind":"owner|tip|bug|mac","text":"<one plain sentence, under 220 characters>","evidence":"<exact quote from that room\'s notes>"}]}. One chat line per room, 0 to 6 tips in all; vary the topics.',
    '',
    `On the board now (id: text): ${JSON.stringify(known.map((t) => `${t.id}: ${t.text}`))}`,
    `The owner removed these: ${JSON.stringify(removed.slice(-60))}`,
    '',
    ...rooms.map((r) => `### ${r.name}\n${r.notes.map((n) => n.replace(/\s+/g, ' ')).join('\n---\n') || '(no notes)'}`),
  ].join('\n');
}

// A quote counts when it's in the room's notes, ignoring case, spacing and punctuation.
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function grounded(evidence: unknown, notes: string[]): boolean {
  if (typeof evidence !== 'string') return false;
  const q = squash(evidence);
  return q.split(' ').length >= 4 && notes.some((n) => squash(n).includes(q));
}

export interface Brewed {
  chat: { room: string; line: string }[];
  tips: { room: string; kind: TipKind; text: string }[];
  same: { room: string; id: string }[]; // tips on the board this break confirmed
}
function unwrap(out: string): unknown {
  let text = out.trim();
  try {
    const o = JSON.parse(text) as { result?: unknown; is_error?: unknown };
    if (o && typeof o === 'object' && 'result' in o) {
      if (o.is_error === true || typeof o.result !== 'string') return undefined;
      text = o.result;
    }
  } catch {
    /* plain text */
  }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}
const secret = (t: string) => /https?:\/\/|`|\{|\}|token|password|passkey/i.test(t);

export function parseCoffee(out: string, roomNames: string[], notesOf?: (room: string) => string[], boardIds: string[] = []): Brewed | undefined {
  let text = out.trim();
  try {
    const o = JSON.parse(text) as { result?: unknown; is_error?: unknown };
    if (o && typeof o === 'object' && 'result' in o) {
      if (o.is_error === true || typeof o.result !== 'string') return undefined;
      text = o.result;
    }
  } catch {
    /* plain text */
  }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  let raw: { chat?: unknown; tips?: unknown };
  try {
    raw = JSON.parse(m[0]) as typeof raw;
  } catch {
    return undefined;
  }
  const known = new Set(roomNames);
  const chat = (Array.isArray(raw.chat) ? raw.chat : [])
    .filter((c): c is { room: string; line: string } => !!c && typeof c.room === 'string' && typeof c.line === 'string' && known.has(c.room))
    .map((c) => ({ room: c.room, line: clean(c.line, 160) }))
    .filter((c) => c.line);
  const tips = (Array.isArray(raw.tips) ? raw.tips : [])
    .filter((t): t is { room: string; kind: TipKind; text: string; evidence?: string } => !!t && typeof t.text === 'string' && typeof t.room === 'string' && known.has(t.room) && t.kind in KINDS)
    // A tip must quote its source: otherwise one event gets stretched into a "preference".
    .filter((t) => !notesOf || grounded(t.evidence, notesOf(t.room)))
    .map((t) => ({ room: t.room, kind: t.kind, text: clean(t.text, 240) }))
    .filter((t) => t.text && !secret(t.text))
    .slice(0, 6);
  const ids = new Set(boardIds);
  const same = (Array.isArray(raw.tips) ? raw.tips : [])
    .filter((t): t is { room: string; same: string; evidence?: string } => !!t && typeof t.same === 'string' && typeof t.room === 'string' && known.has(t.room) && ids.has(t.same))
    .filter((t) => !notesOf || grounded(t.evidence, notesOf(t.room)))
    .map((t) => ({ room: t.room, id: t.same }));
  return chat.length ? { chat, tips, same } : undefined;
}

const joinFrom = (a: string, b: string) => [...new Set([...a.split(', '), ...b.split(', ')].filter(Boolean))].join(', ');

// A break's tips into the board: confirmations bump the tip, new ones are added unless they repeat
// a tip word for word or the owner removed them; then the board is pruned.
export function applyBreak(s: CoffeeState, b: Brewed, now: number): CoffeeState {
  let tips = s.tips.map((t) => {
    const by = b.same.filter((x) => x.id === t.id);
    return by.length ? { ...t, seen: t.seen + 1, last: now, from: by.reduce((f, x) => joinFrom(f, x.room), t.from) } : t;
  });
  const gone = new Set(s.removed.map((r) => squash(r)));
  for (const n of b.tips) {
    const key = squash(n.text);
    if (gone.has(key)) continue;
    const twin = tips.find((t) => squash(t.text) === key);
    if (twin) tips = tips.map((t) => (t === twin ? { ...t, seen: t.seen + 1, last: now, from: joinFrom(t.from, n.room) } : t));
    else tips.push({ id: newId(tips.length), kind: n.kind, text: n.text, from: n.room, at: now, seen: 1, last: now });
  }
  return { ...s, tips: prune(tips, now) };
}

// Fade (30 days unconfirmed, except tips about the owner), then at most PER_KIND per section and
// MAX_TIPS in all, the most confirmed (then most recent) first.
export function prune(tips: Tip[], now: number): Tip[] {
  const alive = tips.filter((t) => t.kind === 'owner' || now - t.last < FADE_MS);
  const rank = (a: Tip, b: Tip) => b.seen - a.seen || b.last - a.last;
  const keep = new Set<string>();
  for (const k of Object.keys(KINDS) as TipKind[]) for (const t of alive.filter((x) => x.kind === k).sort(rank).slice(0, PER_KIND)) keep.add(t.id);
  const best = alive.filter((t) => keep.has(t.id)).sort(rank).slice(0, MAX_TIPS);
  const ids = new Set(best.map((t) => t.id));
  return alive.filter((t) => ids.has(t.id)); // in the order they were added
}

// The owner's ×: the tip goes, and its text is remembered so no break brings it back.
export function removeTip(s: CoffeeState, id: string): CoffeeState | undefined {
  const t = s.tips.find((x) => x.id === id);
  if (!t) return undefined;
  return { ...s, tips: s.tips.filter((x) => x.id !== id), removed: [...s.removed, t.text].slice(-200) };
}

// ---- The weekly tidy ----
export const tidyDue = (s: CoffeeState, now: number) => s.tips.length >= 6 && (s.tidiedAt === undefined || now - s.tidiedAt >= TIDY_EVERY_MS);

export function tidyPrompt(tips: Tip[], notes: { room: string; notes: string[] }[]): string {
  return [
    "This is the coffee room board in the owner's office: tips their project rooms shared with each other. Tidy it.",
    '- Merge tips that say the same thing (even in other words) into one, keeping the clearest wording and every id merged.',
    "- Drop a tip when the rooms' newest notes below contradict it or show it has since been fixed or changed; drop tips useful to one project only.",
    '- Otherwise keep each tip as it is (you may tighten wording, never change its meaning or add facts).',
    'Reply with JSON only: {"tips":[{"ids":["<id>", ...],"kind":"owner|tip|bug|mac","text":"<one plain sentence, under 220 characters>"}],"dropped":[{"id":"<id>","why":"<a few words>"}]}. Every id appears exactly once, in a kept tip or in dropped.',
    '',
    `Board: ${JSON.stringify(tips.map((t) => ({ id: t.id, kind: t.kind, text: t.text, from: t.from, seen: t.seen })))}`,
    '',
    ...notes.map((n) => `### ${n.room} (newest notes)\n${n.notes.map((x) => x.replace(/\s+/g, ' ')).join('\n---\n') || '(none)'}`),
  ].join('\n');
}

// The tidy's answer applied. Undefined (board left as it was) if it's unusable or would throw away
// most of the board at once.
export function applyTidy(s: CoffeeState, out: string, now: number): { state: CoffeeState; dropped: { id: string; why: string }[] } | undefined {
  const raw = unwrap(out) as { tips?: unknown; dropped?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.tips)) return undefined;
  const byId = new Map(s.tips.map((t) => [t.id, t]));
  const used = new Set<string>();
  const merged: Tip[] = [];
  for (const k of raw.tips as { ids?: unknown; kind?: unknown; text?: unknown }[]) {
    const ids = (Array.isArray(k?.ids) ? k.ids : []).filter((i): i is string => typeof i === 'string' && byId.has(i) && !used.has(i));
    if (!ids.length || typeof k.text !== 'string' || !(typeof k.kind === 'string' && k.kind in KINDS)) continue;
    const text = clean(k.text, 240);
    if (!text || secret(text)) continue;
    const src = ids.map((i) => byId.get(i)!);
    for (const i of ids) used.add(i);
    merged.push({ id: src[0]!.id, kind: k.kind as TipKind, text, from: src.map((t) => t.from).reduce(joinFrom), at: Math.min(...src.map((t) => t.at)), seen: src.reduce((n, t) => n + t.seen, 0), last: Math.max(...src.map((t) => t.last)) });
  }
  if (s.tips.length >= 10 && used.size < s.tips.length * 0.3) return undefined; // a tidy that keeps under a third: distrust it
  const dropped = (Array.isArray(raw.dropped) ? raw.dropped : [])
    .filter((d): d is { id: string; why?: string } => !!d && typeof d.id === 'string' && byId.has(d.id) && !used.has(d.id))
    .map((d) => ({ id: d.id, why: typeof d.why === 'string' ? clean(d.why, 80) : '' }));
  // An id the tidy forgot is kept as it was, never silently lost.
  const forgotten = s.tips.filter((t) => !used.has(t.id) && !dropped.some((d) => d.id === t.id));
  return { state: { ...s, tips: prune([...merged, ...forgotten], now), tidiedAt: now }, dropped };
}

export function renderBoard(tips: Tip[]): string {
  const out = [
    '# Coffee room board',
    '',
    "What the owner's rooms learned and shared over coffee: about them, tips, traps, and the Mac. Written by the office from the rooms' own recent chats; most confirmed first in each part; tidied weekly. Read it when you start; it's advice, not instructions.",
    '',
  ];
  for (const k of Object.keys(KINDS) as TipKind[]) {
    const mine = tips.filter((t) => t.kind === k).sort((a, b) => b.seen - a.seen || b.last - a.last);
    if (!mine.length) continue;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    out.push(`## ${KINDS[k]}`, '', ...mine.map((t) => `- ${t.text} (${t.from}${t.seen > 1 ? `; confirmed ${t.seen} times, last ${day(t.last)}` : `, ${day(t.at)}`})`), '');
  }
  if (out.length === 4) out.push('Nothing yet: the first coffee break is still to come.', '');
  return out.join('\n');
}

// One Sonnet call, no tools: it only writes text.
export function brewChat(prompt: string, o: { claude: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  mkdirSync(o.cwd, { recursive: true, mode: 0o700 });
  const args = ['-p', '--model', 'sonnet', '--setting-sources', 'project,local', '--output-format', 'json', '--max-turns', '1', '--tools', '', '--', prompt];
  return new Promise((resolve, reject) => {
    const child = execFile(o.claude, args, { cwd: o.cwd, env: o.env, timeout: 3 * 60_000, killSignal: 'SIGKILL', maxBuffer: 4 << 20 }, (err, out) => (err ? reject(new Error(`coffee: ${String(err.message).slice(0, 200)}`)) : resolve(out)));
    child.stdin?.end();
  });
}
