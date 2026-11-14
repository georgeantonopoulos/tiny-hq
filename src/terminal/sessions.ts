// Each project's agent is a plain Claude Code session in that project's folder,
// started exactly as the owner would start it from a terminal there: their login
// shell's environment, their own settings, skills, hooks and connectors, no extra
// flags. It runs in the background (`claude --bg`) so the manager can message it
// and the owner can join it from the office page (a real terminal running
// `claude attach`). Closing the page only detaches; the session keeps going.

import { execFile, spawn } from 'node:child_process';
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import { CLAUDE_BIN } from '../paths.ts';

const require = createRequire(import.meta.url);

export interface BackgroundSession {
  id: string; // short id that `claude attach` takes
  sessionId: string;
  name?: string;
  cwd: string;
  pid?: number;
  kind?: string; // background | interactive (The owner's own terminal)
  startedAt?: number;
  status?: string; // idle | busy
  state?: string; // working | blocked | done (done = its last reply finished; the session is still running)
}

// node-pty ships ready-built for macOS, but its helper loses the "may run" bit
// because this repo never runs install scripts. Put it back before first use.
function readyPty(): typeof import('node-pty') {
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const helper of [join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), join(root, 'build', 'Release', 'spawn-helper')]) {
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, 0o755);
    }
  }
  return require('node-pty') as typeof import('node-pty');
}

// The owner's terminal environment: what a new Terminal tab gets from their login
// shell (.zprofile and .zshrc). The shell starts from a bare environment, so
// nothing of the office's own (CM_*, or a parent Claude Code's variables)
// reaches a project's Claude. Cached only once it has been read successfully.
let userEnvCache: Promise<NodeJS.ProcessEnv> | undefined;
const MARK = '__CM_ENV_START__';
const BARE_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'] as const;
const NOT_FROM_TERMINAL = /^(CM_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$)/;

function readLoginEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const bare: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    for (const k of BARE_KEYS) if (process.env[k]) bare[k] = process.env[k];
    // stdin closed: an interactive shell with nothing to read can't wait on input.
    const child = spawn(shell, ['-l', '-i', '-c', `printf '\\0${MARK}\\0'; env -0`], { cwd: bare.HOME ?? '/', env: bare, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (out.length < 4 << 20) out += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      clearTimeout(timer);
      const at = out.indexOf(`\0${MARK}\0`);
      if (at < 0) return resolve(undefined);
      const env: NodeJS.ProcessEnv = {};
      for (const pair of out.slice(at + MARK.length + 2).split('\0')) {
        const eq = pair.indexOf('=');
        if (eq > 0 && !NOT_FROM_TERMINAL.test(pair.slice(0, eq))) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      resolve(env.PATH ? env : undefined);
    });
  });
}

export function userEnv(): Promise<NodeJS.ProcessEnv> {
  if (userEnvCache) return userEnvCache;
  const attempt = readLoginEnv().then((env) => {
    if (env) return env;
    // Couldn't read it this time: use a cleaned copy of the daemon's, and try again next time.
    userEnvCache = undefined;
    const fallback = { ...process.env };
    for (const k of Object.keys(fallback)) if (NOT_FROM_TERMINAL.test(k) || /^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)) delete fallback[k];
    return fallback;
  });
  userEnvCache = attempt;
  return attempt;
}

function run(args: string[], cwd: string): Promise<string> {
  return userEnv().then(
    (env) =>
      new Promise((resolve, reject) => {
        execFile(CLAUDE_BIN, args, { cwd, env, timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`claude ${args[0]}: ${String(stderr || err.message).trim().slice(0, 300)}`));
          else resolve(stdout);
        });
      }),
  );
}

export const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// There is only ever one manager: rooms reach them by name, and two sessions called
// "Manager" make every SendMessage to them fail. Given the live sessions and the one
// to keep, these are the others in their folder to stop. A busy one is left alone
// (never cut a session off mid-task); it goes on a later pass once it's idle.
// Pass every session `claude agents` lists, not just running ones: a stale blocked
// session still shows up under the name "Manager", which is what a room can't tell apart.
export function extraManagers<T extends { id: string; realCwd: string; status?: string }>(all: T[], managerDir: string, keepId: string): string[] {
  return all.filter((s) => s.id !== keepId && worksIn(s.realCwd, managerDir) && s.status !== 'busy').map((s) => s.id);
}

// One session per room: the one working now, else the most recently active
// (`activeAt`, default: when it started). The others go once they're idle; `hold`
// says one can't go yet (the owner is watching it, it's waiting on them, or it only
// just finished). The owner's own terminal sessions aren't in this list, so they're
// never touched. Ranking by start time alone let a fresh, never-used session outrank
// one busy in a worktree, and stop it once it paused.
export function extraRoomSessions<T extends { id: string; realCwd: string; status?: string; startedAt?: number }>(all: T[], roomPath: string, hold: (s: T) => boolean = () => false, activeAt: (s: T) => number = (s) => s.startedAt ?? 0): string[] {
  const here = all.filter((s) => worksIn(s.realCwd, roomPath));
  if (here.length < 2) return [];
  const rank = (s: T) => [Number(s.status === 'busy'), activeAt(s)] as const;
  const newest = here.reduce((a, b) => {
    const [ab, at] = rank(a);
    const [bb, bt] = rank(b);
    return bb > ab || (bb === ab && bt > at) ? b : a;
  });
  return here.filter((s) => s !== newest && s.status !== 'busy' && !hold(s)).map((s) => s.id);
}

// The owner's own terminal sessions (they have no short id, so listSessions skips them):
// the only place a real "The owner approved" can come from besides the manager's own chat.
export async function interactiveSessions(): Promise<{ name: string; sessionId?: string; realCwd?: string; status?: string }[]> {
  const out = await run(['agents', '--json'], process.env.HOME ?? '/');
  const rows = JSON.parse(out) as BackgroundSession[] | { sessions?: BackgroundSession[] };
  return (Array.isArray(rows) ? rows : (rows.sessions ?? [])).filter((s) => s.kind === 'interactive' && alive(s.pid)).map((s) => ({ name: s.name ?? s.sessionId ?? 'unnamed', sessionId: s.sessionId, realCwd: s.cwd ? real(s.cwd) : undefined, status: s.status }));
}

// Every listed session (running or not) with its folder resolved.
export async function allSessions(): Promise<(BackgroundSession & { realCwd: string })[]> {
  return (await listSessions()).map((s) => ({ ...s, realCwd: real(s.cwd) }));
}

// Does a session running in `realCwd` belong to the room for `projectPath`? Its own
// folder, or a Claude Code worktree inside it (<project>/.claude/worktrees/<name>),
// which is where a session goes after EnterWorktree. Other subfolders don't count
// (the manager's folder sits inside the office's folder but is not the office's own room).
export function worksIn(realCwd: string, projectPath: string): boolean {
  const want = real(projectPath);
  if (realCwd === want || realCwd.startsWith(`${want}/.claude/worktrees/`)) return true;
  // A worktree of a separate git repo nested in the project
  // (<project>/<sub>/.claude/worktrees/<name>, where <sub> has its own .git) counts too:
  // otherwise the room looks stopped and the office starts a second session there.
  if (!realCwd.startsWith(`${want}/`)) return false;
  const at = realCwd.indexOf('/.claude/worktrees/', want.length);
  if (at < 0) return false;
  const sub = realCwd.slice(0, at);
  return !sub.slice(want.length).includes('/.claude/') && existsSync(join(sub, '.git'));
}

const alive = (pid?: number): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const SHORT_ID = /^[0-9a-f]{8}$/;

export async function listSessions(): Promise<BackgroundSession[]> {
  const out = await run(['agents', '--json'], process.env.HOME ?? '/');
  const rows = JSON.parse(out) as BackgroundSession[] | { sessions?: BackgroundSession[] };
  const list = Array.isArray(rows) ? rows : (rows.sessions ?? []);
  return list.filter((s) => typeof s.id === 'string' && SHORT_ID.test(s.id) && typeof s.cwd === 'string');
}

// Every background session whose process is running, with its folder resolved.
// A running process is what counts: state "done" only means its last reply finished.
export async function liveSessions(): Promise<(BackgroundSession & { realCwd: string })[]> {
  return (await listSessions()).filter((s) => alive(s.pid)).map((s) => ({ ...s, realCwd: real(s.cwd) }));
}

// The live background session in this folder, if there is one.
export async function liveSessionIn(projectPath: string): Promise<BackgroundSession | undefined> {
  const live = (await liveSessions()).filter((s) => worksIn(s.realCwd, projectPath));
  // Prefer one that's mid-task, then the one used most recently.
  return live.sort((a, b) => Number(b.status === 'busy') - Number(a.status === 'busy') || lastActiveAt(b) - lastActiveAt(a))[0];
}

// Starts a fresh session in the project folder, as `claude --bg` from a terminal there.
// With a prompt it starts working on it straight away (that's how the manager hands over work).
// `model`: the one the owner picked for this room (else their own default).
export const MODELS = ['opus', 'sonnet', 'haiku'] as const;
export type Model = (typeof MODELS)[number];
// `brief`: the office's short note for a room's session (its name, who to report to),
// added to Claude's system prompt. Everything else stays the owner's own setup.
export async function startSession(projectPath: string, name: string, prompt?: string, model?: Model, brief?: string): Promise<BackgroundSession> {
  const args = ['--bg', '-n', name.replace(/[^\w .-]/g, '').slice(0, 60) || 'project'];
  if (model && MODELS.includes(model)) args.push('--model', model);
  if (brief) args.push('--append-system-prompt', brief);
  if (prompt) args.push('--', prompt); // a prompt starting with "-" is still the prompt, never an option
  const out = await run(args, projectPath);
  const m = /backgrounded\s*·\s*([0-9a-f]{8})/.exec(out);
  if (!m) throw new Error(`claude --bg didn't say which session it started: ${out.slice(0, 200)}`);
  return { id: m[1]!, sessionId: '', name, cwd: projectPath };
}

export async function stopSession(id: string): Promise<void> {
  if (!SHORT_ID.test(id)) throw new Error('bad session id');
  await run(['stop', id], process.env.HOME ?? '/');
}

// When a session last did anything: the time of the last real message in its
// transcript (The owner's or Claude's). Not the file's modified time: Claude Code also
// writes housekeeping lines (an "away" summary when someone attaches, title
// changes), which made an old session look newest. Falls back to the file time,
// then to when it started.
export function lastActiveAt(s: { sessionId?: string; cwd: string; startedAt?: number }, home = homedir()): number {
  if (!s.sessionId || !/^[0-9a-f-]{36}$/.test(s.sessionId)) return s.startedAt ?? 0;
  const file = join(home, '.claude', 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`);
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"timestamp"') || !/"type":"(user|assistant)"/.test(line)) continue;
      try {
        const r = JSON.parse(line) as { type?: string; timestamp?: string };
        const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
        if ((r.type === 'user' || r.type === 'assistant') && !Number.isNaN(t)) return t;
      } catch {
        // a line cut off at the start of the window
      }
    }
    return fstatSync(fd).mtimeMs;
  } catch {
    return s.startedAt ?? 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A turn where nothing changed ends with exactly this reply (The manager on an idle notice or an empty
// scheduled check, a room checking a job still waiting on the owner). It is visible output, so
// Claude Code doesn't send the session back for "no visible output", but it never becomes a
// speech bubble: otherwise the owner gets "Nothing new" bubbles all day.
export const QUIET = '(quiet)';
export const isQuiet = (t: string): boolean => /^\(?quiet\)?\.?$/i.test(t.trim());

// The last thing a session said, read from the transcript Claude Code already
// saves (~/.claude/projects/<folder>/<session id>.jsonl). Costs no tokens.
// `to`: who it was sent to, when the line was a SendMessage (a room reporting to the manager).
// Pictures a message points at, so the owner can see what a room made without opening it: absolute
// or ~ paths to image files on this Mac that exist, at most four, so the bubble can show them.
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
export function imagesIn(text: string, home = homedir()): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:~|\/(?:Users|Volumes|private|tmp|var\/folders))\/[^\s`'"<>()\[\]|*]+?\.(?:png|jpe?g|gif|webp)\b/gi)) {
    const p = m[0].startsWith('~') ? join(home, m[0].slice(1)) : m[0];
    if (out.includes(p)) continue;
    try {
      if (statSync(p).isFile()) out.push(p);
    } catch {
      /* not on this Mac (or not any more) */
    }
    if (out.length >= 4) break;
  }
  return out;
}

export function lastSaid(sessionId: string, cwd: string, home = homedir()): { text: string; at: string; to?: string; images?: string[] } | undefined {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return undefined;
  const file = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    // A file sent to the owner with SendUserFile ({ files: [...] }) counts as a picture the message points
    // at, also when it went a few steps before the final message of the same turn (a before/after
    // picture sent that way used to be missing from the bubble).
    const sentFiles = (content: { type?: string; name?: string; input?: unknown }[]) =>
      content.flatMap((b) => (b.type === 'tool_use' && b.name === 'SendUserFile' ? Object.values((b.input ?? {}) as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string' && IMAGE_EXT.test(v)) : []));
    let found: { text: string; at: string; to?: string; files: string[] } | undefined;
    for (const line of lines) {
      if (found && line.includes('"user"')) {
        // The turn began at the owner's (or another session's) message: stop there. Tool results don't end it.
        try {
          const u = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          const c = u.message?.content;
          if (u.type === 'user' && (typeof c === 'string' || (Array.isArray(c) && c.some((x) => (x as { type?: string })?.type === 'text')))) break;
        } catch {
          /* cut off */
        }
        continue;
      }
      if (!line.includes('"assistant"')) continue;
      try {
        const r = JSON.parse(line) as { type?: string; timestamp?: string; message?: { content?: { type?: string; text?: string; name?: string; input?: { message?: unknown; to?: unknown } }[] } };
        if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
        if (found) {
          found.files.push(...sentFiles(r.message!.content!));
          continue;
        }
        // What it wrote, or what it sent to another session (a project reporting back to the manager).
        const parts = r.message!.content!.flatMap((b) =>
          b.type === 'text' && b.text?.trim() ? [b.text.trim()] : b.type === 'tool_use' && b.name === 'SendMessage' && typeof b.input?.message === 'string' && b.input.message.trim() ? [b.input.message.trim()] : [],
        );
        const text = parts.join(' ');
        if (isQuiet(text)) continue; // a quiet turn: the bubble keeps the last real thing said
        const sent = r.message!.content!.filter((b) => b.type === 'tool_use' && b.name === 'SendMessage' && typeof b.input?.to === 'string').pop();
        if (text) found = { text, at: r.timestamp ?? '', ...(sent ? { to: String(sent.input!.to).replace(/\s*\[[^\]]*\]\s*$/, '').trim() } : {}), files: sentFiles(r.message!.content!) };
      } catch {
        // a line cut off at the start of the window
      }
    }
    if (found) {
      const { files, ...said } = found;
      const images = imagesIn([said.text, ...files].join(' '), home);
      return { ...said, ...(images.length ? { images } : {}) };
    }
  } catch {
    // no transcript yet (nothing said)
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

// ---- What a session is doing, read from its saved transcript (no tokens) ----

// Terminal escape codes and control characters never reach a person or the manager.
const plainText = (t: string): string =>
  t
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

type Block = { type?: string; text?: string; name?: string; id?: string; tool_use_id?: string; input?: Record<string, unknown> };
type Rec = { type?: string; timestamp?: string; message?: { content?: Block[] | string } };

// The tail of a session's transcript, newest record first.
function tailRecords(sessionId: string, cwd: string, home: string): Rec[] {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return [];
  const file = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const out: Rec[] = [];
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      try {
        if (line.startsWith('{')) out.push(JSON.parse(line) as Rec);
      } catch {
        // a line cut off at the start of the window
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const blocksOf = (r: Rec): Block[] => (Array.isArray(r.message?.content) ? r.message!.content : []);

// A tool call in plain words: "Bash: pnpm test", "Edit: sessions.ts".
export function describeTool(b: Block): string {
  const i = b.input ?? {};
  const str = (k: string) => (typeof i[k] === 'string' ? plainText(i[k] as string) : '');
  const name = b.name ?? 'a tool';
  const file = str('file_path') || str('path') || str('notebook_path');
  const detail = name === 'Bash' ? str('command') : file ? file.split('/').pop()! : str('pattern') || str('query') || str('url') || str('description') || str('to');
  return (detail ? `${name}: ${detail}` : name).slice(0, 120);
}

// The last thing a session did, in plain words (a tool it ran, or what it said).
// Raw `claude logs` output is terminal escape codes; the transcript is readable.
export function lastAction(sessionId: string, cwd: string, home = homedir()): { text: string; at: string } | undefined {
  for (const r of tailRecords(sessionId, cwd, home)) {
    if (r.type !== 'assistant') continue;
    const bs = blocksOf(r);
    const tool = bs.filter((b) => b.type === 'tool_use').pop();
    if (tool) return { text: describeTool(tool), at: r.timestamp ?? '' };
    const said = bs.filter((b) => b.type === 'text' && b.text?.trim()).pop();
    if (said) return { text: `said: ${plainText(said.text!)}`.slice(0, 160), at: r.timestamp ?? '' };
  }
  return undefined;
}

// What a blocked session is waiting for the owner on: a question it asked them
// (AskUserQuestion), or a permission prompt (a tool call that never got a result).
// Anything else is 'unknown': open the room and look.
export function waitingOn(sessionId: string, cwd: string, home = homedir()): { kind: 'question' | 'permission' | 'unknown'; text: string } {
  const answered = new Set<string>();
  for (const r of tailRecords(sessionId, cwd, home)) {
    if (r.type === 'user') {
      for (const b of blocksOf(r)) if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
      continue;
    }
    if (r.type !== 'assistant') continue;
    const open = blocksOf(r).filter((b) => b.type === 'tool_use' && !(b.id && answered.has(b.id)));
    const ask = open.find((b) => b.name === 'AskUserQuestion');
    if (ask) {
      const qs = ask.input?.questions;
      const q = Array.isArray(qs) && typeof (qs[0] as { question?: unknown } | undefined)?.question === 'string' ? (qs[0] as { question: string }).question : '';
      return { kind: 'question', text: plainText(q).slice(0, 160) || 'a question for the owner' };
    }
    if (open.length) return { kind: 'permission', text: `permission to use ${describeTool(open[0]!)}` };
    const said = blocksOf(r).filter((b) => b.type === 'text' && b.text?.trim()).pop();
    return { kind: 'unknown', text: said ? `last said: ${plainText(said.text!)}`.slice(0, 160) : 'unclear: open the room' };
  }
  return { kind: 'unknown', text: 'unclear: open the room' };
}

// A permission prompt on screen right now. Claude Code still says "working" while a session
// waits at one, so the office can't go by its state (a room could sit on a prompt with
// nothing over its head). hooks/office-waiting.mjs notes each prompt as it opens, in
// <dataDir>/waiting/<sessionId>.json; it stands while the transcript still has the request
// unanswered (a fresh note counts even before the transcript catches up). Once answered,
// the note is cleared. Until an approved command finishes, it still reads as waiting.
export const FRESH_NOTE_MS = 15_000;
export function promptPending(sessionId: string, cwd: string, dataDir: string, home = homedir(), now = Date.now()): { kind: 'permission'; text: string } | undefined {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return undefined;
  const file = join(dataDir, 'waiting', `${sessionId}.json`);
  let note: { at?: unknown; tool?: unknown; what?: unknown };
  try {
    note = JSON.parse(readFileSync(file, 'utf8')) as typeof note;
  } catch {
    return undefined;
  }
  const at = typeof note.at === 'number' ? note.at : 0;
  const tool = typeof note.tool === 'string' ? note.tool : '';
  const what = typeof note.what === 'string' ? note.what : '';
  // The very call that asked, still without a result (a later call doesn't count: the
  // session moved on, so that prompt was answered).
  const answered = new Set<string>();
  for (const r of tailRecords(sessionId, cwd, home)) {
    if (r.type === 'user') {
      for (const b of blocksOf(r)) if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id);
      continue;
    }
    if (r.type !== 'assistant') continue;
    const call = blocksOf(r).find((b) => b.type === 'tool_use' && b.name === tool && noteText(b) === what);
    if (call && !(call.id && answered.has(call.id))) return { kind: 'permission', text: `permission to use ${describeTool(call)}` };
    if (call) break;
  }
  if (now - at < FRESH_NOTE_MS) return { kind: 'permission', text: `permission to use ${tool || 'a tool'}${what ? `: ${what}` : ''}`.slice(0, 160) };
  try {
    rmSync(file, { force: true }); // answered
  } catch {
    /* next look */
  }
  return undefined;
}

// What the hook notes about a call (hooks/office-waiting.mjs keeps the same rule).
function noteText(b: Block): string {
  const i = b.input ?? {};
  const v = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : typeof i.url === 'string' ? i.url : '';
  return v.replace(/\s+/g, ' ').trim().slice(0, 120);
}

// ---- Terminals: the owner's view into a session from the office page ----

export interface Terminal {
  id: string;
  sessionId: string; // the short session id it's attached to
  write(data: string): void;
  resize(cols: number, rows: number, repaint?: boolean): void;
  // Replays what's on screen so far, then streams. Returns an unsubscribe.
  subscribe(onData: (chunk: string) => void, onExit: () => void): () => void;
  close(): void;
  viewers(): number; // pages watching it right now (The owner, on the Mac or phone)
  ready(): boolean; // Claude's screen is up, so typed input reaches its prompt
  typed(data: string): void; // the owner's own keys from the office page (also written to the session)
  drafting(now?: number): boolean; // the owner has typed something there and not sent it yet
}

// The owner's unsent message in a session's chat. Without this, the owner could be typing to the manager on their phone while
// the office typed Otto's report into the same box, and Enter sent both as one message. Keys from
// The owner start a draft; Enter (or Ctrl-C clearing it) ends it; a draft untouched for 10
// minutes is taken as abandoned, so the office isn't held up for ever.
export const DRAFT_TIMEOUT_MS = 10 * 60_000;
export function draftAfter(state: { since?: number; last?: number }, data: string, now = Date.now()): void {
  // A lone Esc doesn't clear Claude's box, and line breaks inside a pasted block
  // (ESC[200~ … ESC[201~) aren't Enter.
  const outsidePaste = data.replace(/\x1b\[200~[\s\S]*?(\x1b\[201~|$)/g, 'p');
  if (/[\r\x03]/.test(outsidePaste)) {
    state.since = undefined;
    state.last = undefined;
    return;
  }
  // Only keys that put text in the box (not arrows, focus reports or resize noise).
  if (!/[^\x00-\x1f\x7f]/.test(data.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO./g, ''))) return;
  state.since ??= now;
  state.last = now;
}
export const isDrafting = (state: { last?: number }, now = Date.now()): boolean => state.last !== undefined && now - state.last < DRAFT_TIMEOUT_MS;

const MAX_BACKLOG = 256 * 1024;

// Claude's full screen is up once it switches to the alternate screen (ESC[?1049h), and
// down again if it switches back (ESC[?1049l). Tracked as the output streams, not by
// searching the backlog: a viewer kept attached for hours (The manager's) scrolls the switch
// out of the backlog, and then nothing could ever be typed into it.
const SCREEN_ON = '\x1b[?1049h';
const SCREEN_OFF = '\x1b[?1049l';
export function trackScreen(state: { up: boolean; tail: string }, chunk: string): void {
  const s = state.tail + chunk; // a switch split across two chunks still counts
  const on = s.lastIndexOf(SCREEN_ON);
  const off = s.lastIndexOf(SCREEN_OFF);
  if (on > off) state.up = true;
  else if (off > on) state.up = false;
  state.tail = s.slice(-(SCREEN_ON.length - 1));
}
const DETACH_AFTER_MS = 10 * 60_000; // nobody watching for this long: detach (the session keeps running)

export class Terminals {
  private readonly open = new Map<string, Terminal>();

  get(id: string): Terminal | undefined {
    return this.open.get(id);
  }

  // A viewer already attached to this session: reused, so opening it again is instant
  // (and the Mac and the phone can watch the same one).
  forSession(sessionId: string): Terminal | undefined {
    for (const t of this.open.values()) if (t.sessionId === sessionId) return t;
    return undefined;
  }

  // `keep`: never detach for being unwatched (The manager's, kept warm).
  async attach(sessionId: string, cols: number, rows: number, keep = false): Promise<Terminal> {
    if (!SHORT_ID.test(sessionId)) throw new Error('bad session id');
    const pty = readyPty();
    const env = await userEnv();
    const proc: IPty = pty.spawn(CLAUDE_BIN, ['attach', sessionId], {
      name: 'xterm-256color',
      cols: clamp(cols, 20, 400, 120),
      rows: clamp(rows, 5, 200, 32),
      cwd: env.HOME ?? process.env.HOME ?? '/',
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    const id = randomUUID();
    let backlog = '';
    let exited = false;
    const listeners = new Set<{ onData: (c: string) => void; onExit: () => void }>();
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      if (!listeners.size && !exited && !keep) idleTimer = setTimeout(() => term.close(), DETACH_AFTER_MS).unref();
    };
    const screen = { up: false, tail: '' };
    const draft: { since?: number; last?: number } = {};
    proc.onData((d) => {
      trackScreen(screen, d);
      backlog = (backlog + d).slice(-MAX_BACKLOG);
      for (const l of listeners) l.onData(d);
    });
    proc.onExit(() => {
      exited = true;
      this.open.delete(id);
      clearTimeout(idleTimer);
      for (const l of listeners) l.onExit();
      listeners.clear();
    });
    const term: Terminal = {
      id,
      sessionId,
      write: (data) => {
        if (!exited) proc.write(data);
      },
      resize: (c, r, repaint = false) => {
        if (exited) return;
        const cols = clamp(c, 20, 400, 120);
        const rows = clamp(r, 5, 200, 32);
        // A new viewer: nudge the size so Claude redraws the whole screen for it.
        if (repaint) {
          proc.resize(cols, Math.max(5, rows - 1));
          setTimeout(() => !exited && proc.resize(cols, rows), 60);
        } else proc.resize(cols, rows);
      },
      subscribe: (onData, onExit) => {
        // The screen switch may have scrolled out of the backlog: put it back so the viewer draws full-screen.
        if (backlog) onData(screen.up && !backlog.includes(SCREEN_ON) ? SCREEN_ON + backlog : backlog);
        if (exited) {
          onExit();
          return () => undefined;
        }
        const l = { onData, onExit };
        listeners.add(l);
        clearTimeout(idleTimer);
        return () => {
          listeners.delete(l);
          armIdle();
        };
      },
      viewers: () => listeners.size,
      ready: () => !exited && screen.up,
      typed: (data) => {
        draftAfter(draft, data);
        if (!exited) proc.write(data);
      },
      drafting: (now = Date.now()) => isDrafting(draft, now),
      // Detach only: `claude attach` exits, the background session carries on.
      close: () => {
        if (!exited) proc.kill('SIGHUP');
      },
    };
    this.open.set(id, term);
    armIdle();
    return term;
  }

  closeAll(): void {
    for (const t of this.open.values()) t.close();
  }
}

function clamp(n: number, lo: number, hi: number, dflt: number): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
}

// The live manager's address for rooms (see writeManagerAddress in src/daemon/main.ts).
export function managerAddress(pid: number | undefined, sockDir = '/tmp/cc-socks'): string {
  const sock = pid ? join(sockDir, `${pid}.sock`) : '';
  return sock && existsSync(sock) ? `uds:${sock}` : 'Manager';
}
