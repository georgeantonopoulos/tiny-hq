// The daemon's HTTP API. Bound to 127.0.0.1 only, every route except /health
// needs the local token (or, over Tailscale, the owner's login plus a paired
// device key), and requests from other hosts or web pages are refused.
//
//   GET  /health                      liveness, no data
//   POST /api/login {code}            swap a one-time sign-in code for the token (or a device key)
//   POST /api/login-code[?for=pairing]   mint a sign-in code (Mac only)
//   GET  /api/devices, POST /api/devices/:id/forget   paired phones
//   GET  /api/floor[?refresh=1]       the office floor plan built from discovery
//   GET  /api/sessions                which project and manager sessions are running
//   POST /api/model {projectPath, model: opus|sonnet|haiku}   the model for a room's Claude
//   POST /api/term/open {projectPath, mode: join|new, cols, rows, confirm?}   a terminal on that folder's Claude session
//   GET  /api/term/:id/stream (SSE), POST /api/term/:id/{input,resize,close}
//   GET  /, /app/*, /style.css, /vendor/*   the office page (no data in it)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tokenMatches } from './token.ts';
import { serveStatic } from './web.ts';
import { audit, type Devices, type RateLimit, type RemoteConfig } from './remote.ts';
import type { Terminal } from '../terminal/sessions.ts';

export interface DaemonDeps {
  token: string;
  port: number;
  floor?: (refresh: boolean) => unknown | Promise<unknown>;
  // Person id ("manager", "lead:<room>") -> busy | idle, for every running session on the floor.
  sessions?: () => Promise<Record<string, 'busy' | 'idle'>>;
  // The owner picks the model for a room's Claude.
  setModel?: (projectPath: string, model: string) => Promise<{ applied: 'now' | 'next' }>;
  // Person id -> the last thing their session said (the manager's speech bubble).
  said?: () => Promise<Record<string, { text: string; at: string; images?: number }>>;
  // The i-th picture the person's last message points at (a path the office found in it), if any.
  saidImage?: (who: string, i: number) => string | undefined;
  // Person id -> what their blocked session is waiting for the owner on (permission or question).
  waiting?: () => Promise<Record<string, { kind: string; text: string }>>;
  // The manager's timetable: the scheduled tasks, and the owner switching one on or off.
  schedule?: { list: () => unknown; setEnabled: (id: string, enabled: boolean) => boolean };
  // The manager's notebook (per-project state and what's next), for the whiteboard.
  board?: () => Promise<{ notebook: string; updatedAt: number; jobs?: { id: string; room: string; title: string; done: string; status: string; waitingFor?: string; holdFor?: string; holdUntil?: number }[]; dismissed?: { room: string; text: string; job?: string; at: number }[]; goals?: Record<string, string>; office?: string[] }>;
  // The owner set (or cleared, with '') a room's goal on the whiteboard; `folder` is the room's project folder.
  boardGoal?: (folder: string, goal: string) => Promise<void>;
  // The owner clicked Action on a whiteboard suggestion: the manager gets it, as from the owner.
  boardAction?: (room: string, next: string) => Promise<void>;
  // The owner clicked × on a whiteboard suggestion or job: they don't want it actioned; the manager is told.
  // `undo`: they brought it back from the whiteboard's Dismissed list.
  boardDismiss?: (room: string, text: string, job?: string, undo?: boolean) => Promise<void>;
  // Yes/no questions sessions put on the floor, and the owner answering one with its button.
  // When a job was last finished (the page plays a little chime when it moves on).
  lastDone?: () => number | undefined;
  // The usage board: the usage meter's last reading for Claude and Codex (empty with no meter).
  usage?: () => Promise<unknown>;
  // The office's written happenings (the Haiku writer's pool; see src/office/gags.ts).
  gags?: () => unknown;
  // The owner's desk: reports they asked for (src/team/desk.ts). `open` marks one read.
  desk?: { list: () => unknown[]; open: (id: string) => unknown | undefined; unread: () => number };
  // The coffee room (src/team/coffee.ts): the last break (who said what) and the board.
  coffee?: { last: () => unknown; board: () => unknown; remove: (id: string) => boolean };
  // The office's microphone: what the owner said (the page's speech recognition), typed into the manager's chat.
  say?: (text: string, from?: From) => Promise<void>;
  asks?: { list: () => Promise<Record<string, { id: string; question: string; more?: number; options?: string[]; tried?: string; password?: boolean; post?: string }>>; answer: (id: string, answer: { yes: boolean } | { choice: number } | { signIn: true }, from?: From) => Promise<void> };
  // The owner joins (or starts) the Claude Code session in a project's folder, or the manager's.
  terminal?: {
    open: (projectPath: string, mode: 'join' | 'new' | 'resume', cols: number, rows: number) => Promise<{ termId: string; session: string; fresh: boolean }>;
    get: (termId: string) => Terminal | undefined;
  };
  // Reaching the office over the owner's Tailscale network (see remote.ts).
  // `port` is a second loopback-only port that only `tailscale serve` points at:
  // a request is remote because of the door it came in by, never because of a header.
  remote?: { config: RemoteConfig; port: number; devices: Devices; signIns: RateLimit; auditPath: string };
}

// One-time sign-in codes: `tiny-hq open` mints one with the token and opens the
// browser on /#code=..., and the page swaps it for the token. The code is
// single-use and expires in a minute, so seeing it in a process list is harmless.
const CODE_TTL_MS = 60_000;

const MAX_BODY = 64 * 1024;

// Which device the owner used, so their messages say whether they came from their phone or the
// Mac: the office's own address is the Mac; over Tailscale, a phone by its browser.
export type From = 'mac' | 'phone' | 'other';
export function fromOf(req: IncomingMessage, remote: boolean): From {
  if (!remote) return 'mac';
  return /Android|iPhone|iPad|Mobile/i.test(String(req.headers['user-agent'] ?? '')) ? 'phone' : 'other';
}
export const fromWords = (f?: From) => (f === 'phone' ? 'on their phone' : f === 'mac' ? 'at the Mac' : f === 'other' ? 'on another device (not the Mac)' : '');

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

class BodyTooLarge extends Error {}

async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new BodyTooLarge('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readText(req: IncomingMessage): Promise<string> {
  return (await readBytes(req, MAX_BODY)).toString('utf8');
}

// Images pasted or dropped into a terminal in the page: saved on the Mac, and
// their path is pasted into Claude, which attaches the file as an image.
const MAX_IMAGE = 15 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const PASTES_DIR = join(homedir(), '.tiny-hq', 'pastes');
// Documents the owner attaches from the page, phone included: Claude reads them from the path.
const MAX_DOC = 30 * 1024 * 1024;
const DOC_EXTS = new Set(['pdf', 'txt', 'md', 'csv', 'json', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic']);
// The file's own name, made safe: letters, digits, dot, dash, underscore; the extension kept.
export function attachName(raw: string): { base: string; ext: string } | undefined {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* as given */
  }
  name = name.split(/[\\/]/).pop() ?? '';
  const m = /^(.*?)\.([A-Za-z0-9]{1,5})$/.exec(name.trim());
  if (!m) return undefined;
  const ext = m[2]!.toLowerCase();
  if (!DOC_EXTS.has(ext)) return undefined;
  // Letters in any language stay (a file named in Greek or Japanese keeps its name).
  const base = m[1]!.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'file';
  return { base, ext };
}

function savePastedImage(bytes: Buffer, ext: string, dir = PASTES_DIR, name = ''): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Old pastes go after a week.
  for (const f of readdirSync(dir)) {
    try {
      if (Date.now() - statSync(join(dir, f)).mtimeMs > 7 * 86_400_000) unlinkSync(join(dir, f));
    } catch {
      /* already gone */
    }
  }
  const path = join(dir, `paste-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}${name ? `-${name}` : ''}.${ext}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return JSON.parse(await readText(req));
}

export function createDaemon(deps: DaemonDeps): Server {
  const allowedHosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const rc = deps.remote;
  // https when Tailscale has a certificate; plain http still runs inside Tailscale's own encryption.
  const remoteOrigins = new Set(rc ? [`https://${rc.config.host}`, `http://${rc.config.host}`] : []);
  const lastAudited = new Map<string, number>(); // device id -> when its session was last logged
  let lastRefusalLogged = 0;
  const refuse = (entry: Record<string, unknown>) => {
    // At most one refusal line a second, so nobody can fill the disk.
    if (Date.now() - lastRefusalLogged < 1000) return;
    lastRefusalLogged = Date.now();
    audit(rc!.auditPath, { event: 'refused', ...entry });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, remote: boolean): Promise<void> => {
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = req.headers.origin;
    if (remote) {
      // Came in by the Tailscale door: only the owner's own account gets anything at all, even the page.
      const who = String(req.headers['tailscale-user-login'] ?? '').toLowerCase();
      if (who !== rc!.config.login) {
        refuse({ reason: 'not the owner on Tailscale', who: who.slice(0, 80) || '(none)', path: (req.url ?? '').slice(0, 80) });
        return send(res, 403, { error: 'not allowed' });
      }
      if (origin && !remoteOrigins.has(origin)) return send(res, 403, { error: 'cross-site requests are refused' });
    } else {
      // Block DNS-rebinding and requests from any other web page.
      if (!allowedHosts.has(host)) return send(res, 421, { error: 'wrong host' });
      if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: 'cross-site requests are refused' });
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && serveStatic(url.pathname, res)) return;

    if (req.method === 'POST' && url.pathname === '/api/login') {
      let code: unknown;
      try {
        code = ((await readJson(req)) as { code?: unknown } | null)?.code;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (remote && !rc!.signIns.allow()) {
        audit(rc!.auditPath, { event: 'refused', reason: 'too many sign-in attempts' });
        return send(res, 429, { error: 'too many tries, wait a few minutes' });
      }
      const expires = typeof code === 'string' ? codes.get(code) : undefined;
      if (typeof code === 'string') codes.delete(code);
      if (!expires || expires < Date.now()) {
        if (remote) audit(rc!.auditPath, { event: 'refused', reason: 'bad or expired sign-in link' });
        return send(res, 401, { error: 'code expired or already used' });
      }
      if (!remote) return send(res, 200, { token: deps.token });
      // A remote browser gets its own key, never the Mac's token.
      const { device, key } = rc!.devices.pair(String(req.headers['user-agent'] ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 80));
      audit(rc!.auditPath, { event: 'paired', device: device.id, label: device.label });
      return send(res, 200, { token: key, device: true });
    }

    const auth = req.headers.authorization;
    const given = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    let device: ReturnType<Devices['check']>;
    if (remote) {
      device = rc!.devices.check(given);
      if (!device) {
        refuse({ reason: 'unknown or forgotten device key' });
        return send(res, 401, { error: 'this device is not paired' });
      }
      const last = lastAudited.get(device.id) ?? 0;
      if (Date.now() - last > 30 * 60_000) {
        lastAudited.set(device.id, Date.now());
        audit(rc!.auditPath, { event: 'session', device: device.id, label: device.label });
      }
    } else if (!tokenMatches(deps.token, given)) {
      return send(res, 401, { error: 'missing or wrong token' });
    }

    // Paired devices: see them and forget them (from the Mac or a paired phone).
    if (rc && req.method === 'GET' && url.pathname === '/api/devices') {
      return send(res, 200, { items: rc.devices.list().map(({ hash: _h, ...d }) => d) });
    }
    const dm = /^\/api\/devices\/([0-9a-f-]{36})\/forget$/.exec(url.pathname);
    if (rc && dm && req.method === 'POST') {
      const ok = rc.devices.revoke(dm[1]!);
      if (ok) audit(rc.auditPath, { event: 'forgotten', device: dm[1], remote });
      return send(res, ok ? 200 : 404, { ok });
    }

    if (req.method === 'POST' && url.pathname === '/api/login-code') {
      // Sign-in links are only ever made on the Mac itself.
      if (remote) return send(res, 403, { error: 'sign-in links can only be made on the Mac' });
      const code = randomBytes(24).toString('hex');
      // A link for pairing a phone lasts 10 minutes (time to pick it up); a local one, a minute.
      codes.set(code, Date.now() + (url.searchParams.get('for') === 'pairing' ? 10 * 60_000 : CODE_TTL_MS));
      for (const [c, exp] of codes) if (exp < Date.now()) codes.delete(c);
      return send(res, 200, { code });
    }

    if (req.method === 'GET' && url.pathname === '/api/floor' && deps.floor) {
      return send(res, 200, await deps.floor(url.searchParams.get('refresh') === '1'));
    }
    if (req.method === 'GET' && url.pathname === '/api/schedule' && deps.schedule) {
      return send(res, 200, deps.schedule.list());
    }
    const sm = /^\/api\/schedule\/([a-z0-9-]{1,41})$/.exec(url.pathname);
    if (sm && req.method === 'POST' && deps.schedule) {
      let b: { enabled?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (typeof b.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be true or false' });
      return deps.schedule.setEnabled(sm[1]!, b.enabled) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such task' });
    }
    if (req.method === 'GET' && url.pathname === '/api/coffee' && deps.coffee) {
      return send(res, 200, deps.coffee.board());
    }
    // The owner's × on a coffee board tip.
    const coffeeM = /^\/api\/coffee\/([a-z0-9]{4,16})\/remove$/.exec(url.pathname);
    if (coffeeM && req.method === 'POST' && deps.coffee) {
      return deps.coffee.remove(coffeeM[1]!) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'that tip is already gone' });
    }
    if (req.method === 'GET' && url.pathname === '/api/desk' && deps.desk) {
      return send(res, 200, { reports: deps.desk.list() });
    }
    const deskM = /^\/api\/desk\/([a-z0-9]{8,16})$/.exec(url.pathname);
    if (deskM && req.method === 'GET' && deps.desk) {
      const r = deps.desk.open(deskM[1]!);
      return r ? send(res, 200, r) : send(res, 404, { error: 'no such report' });
    }
    if (req.method === 'GET' && url.pathname === '/api/gags' && deps.gags) {
      return send(res, 200, deps.gags());
    }
    if (req.method === 'GET' && url.pathname === '/api/usage' && deps.usage) {
      return send(res, 200, await deps.usage());
    }
    if (deps.say && req.method === 'POST' && url.pathname === '/api/say') {
      let b: { text?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) return send(res, 400, { error: 'text required (up to 4000 characters)' });
      try {
        await deps.say(b.text, fromOf(req, remote));
        if (remote) audit(rc!.auditPath, { event: 'say', chars: b.text.length, device: device!.id });
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, (err as { status?: number }).status ?? 500, { error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/board' && deps.board) {
      return send(res, 200, await deps.board());
    }
    // A picture from someone's last message, for their bubble. Only a path the office itself
    // found in that message, only image files, at most 20 MB.
    if (req.method === 'GET' && url.pathname === '/api/said-image' && deps.saidImage) {
      const who = url.searchParams.get('who') ?? '';
      const i = Number(url.searchParams.get('i'));
      const file = Number.isInteger(i) && i >= 0 && i < 4 ? deps.saidImage(who, i) : undefined;
      const type = file ? IMAGE_MIME[(file.match(/\.([a-z]+)$/i)?.[1] ?? '').toLowerCase()] : undefined;
      if (!file || !type) return send(res, 404, { error: 'no such picture' });
      try {
        const st = statSync(file);
        if (!st.isFile() || st.size > 20 * 1024 * 1024) return send(res, 404, { error: 'no such picture' });
        // Opened before the reply starts, so a picture the office can see but not read (a protected
        // folder, or gone since) is a 404; a read error later only ends this reply, never the office.
        const fd = openSync(file, 'r');
        res.writeHead(200, { 'content-type': type, 'content-length': String(st.size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        createReadStream('', { fd }).on('error', () => res.destroy()).pipe(res);
      } catch {
        send(res, 404, { error: 'no such picture' });
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions' && deps.sessions) {
      const [sessions, said, waiting, asks] = await Promise.all([deps.sessions(), deps.said ? deps.said().catch(() => ({})) : Promise.resolve({}), deps.waiting ? deps.waiting().catch(() => ({})) : Promise.resolve(undefined), deps.asks ? deps.asks.list().catch(() => ({})) : Promise.resolve(undefined)]);
      const lastDone = deps.lastDone?.();
      const deskUnread = deps.desk?.unread();
      const coffee = deps.coffee?.last();
      return send(res, 200, { sessions, said, ...(asks ? { asks } : {}), ...(waiting ? { waiting } : {}), ...(lastDone ? { lastDone } : {}), ...(deskUnread !== undefined ? { deskUnread } : {}), ...(coffee ? { coffee } : {}) });
    }
    if (deps.boardAction && req.method === 'POST' && url.pathname === '/api/board/action') {
      let b: { room?: unknown; next?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (typeof b.room !== 'string' || typeof b.next !== 'string' || !b.room.trim() || !b.next.trim()) return send(res, 400, { error: 'room and next required' });
      try {
        await deps.boardAction(b.room.slice(0, 100), b.next.slice(0, 600));
        if (remote) audit(rc!.auditPath, { event: 'board-action', room: b.room.slice(0, 100), device: device!.id });
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, (err as { status?: number }).status ?? 500, { error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }
    if (deps.boardGoal && req.method === 'POST' && url.pathname === '/api/board/goal') {
      let b: { folder?: unknown; goal?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (typeof b.folder !== 'string' || !b.folder.startsWith('/') || typeof b.goal !== 'string') return send(res, 400, { error: 'folder and goal required' });
      try {
        await deps.boardGoal(b.folder.slice(0, 400), b.goal.slice(0, 400));
        if (remote) audit(rc!.auditPath, { event: 'board-goal', folder: b.folder.slice(0, 400), device: device!.id });
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, (err as { status?: number }).status ?? 500, { error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }
    if (deps.boardDismiss && req.method === 'POST' && url.pathname === '/api/board/dismiss') {
      let b: { room?: unknown; text?: unknown; job?: unknown; undo?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (typeof b.room !== 'string' || typeof b.text !== 'string' || !b.room.trim() || !b.text.trim()) return send(res, 400, { error: 'room and text required' });
      const job = typeof b.job === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(b.job) ? b.job : undefined;
      try {
        const undo = b.undo === true;
        await deps.boardDismiss(b.room.slice(0, 100), b.text.slice(0, 600), job, undo);
        if (remote) audit(rc!.auditPath, { event: undo ? 'board-undismiss' : 'board-dismiss', room: b.room.slice(0, 100), device: device!.id });
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, (err as { status?: number }).status ?? 500, { error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }
    const am = /^\/api\/asks\/([a-z0-9]{6,16})$/.exec(url.pathname);
    if (deps.asks && am && req.method === 'POST') {
      let b: { yes?: unknown; choice?: unknown; signIn?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      // Yes / No, or the number of the option the owner picked on a multiple-choice question.
      const answer = b.signIn === true ? ({ signIn: true } as const) : typeof b.yes === 'boolean' ? { yes: b.yes } : Number.isInteger(b.choice) && (b.choice as number) >= 0 && (b.choice as number) < 6 ? { choice: b.choice as number } : undefined;
      if (!answer) return send(res, 400, { error: 'yes (true/false), signIn (true) or choice (0-5) required' });
      try {
        await deps.asks.answer(am[1]!, answer, fromOf(req, remote));
        if (remote) audit(rc!.auditPath, { event: 'answer', ask: am[1]!, ...answer, device: device!.id });
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, (err as { status?: number }).status ?? 500, { error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }

    if (deps.setModel && req.method === 'POST' && url.pathname === '/api/model') {
      let b: { projectPath?: unknown; model?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (typeof b.projectPath !== 'string' || typeof b.model !== 'string') return send(res, 400, { error: 'projectPath and model required' });
      try {
        return send(res, 200, await deps.setModel(b.projectPath, b.model));
      } catch (err) {
        return send(res, (err as { status?: number }).status ?? 500, { error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }
    if (deps.terminal && req.method === 'POST' && url.pathname === '/api/term/open') {
      let b: { projectPath?: unknown; mode?: unknown; cols?: unknown; rows?: unknown; confirm?: unknown };
      try {
        b = ((await readJson(req)) ?? {}) as typeof b;
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (typeof b.projectPath !== 'string') return send(res, 400, { error: 'projectPath required' });
      // resume: join only, never start one (the page reopening the owner's last tab on load).
      const mode = b.mode === 'new' ? 'new' : b.mode === 'resume' ? 'resume' : 'join';
      // From a phone, a terminal is a full shell as the owner: the page must have asked them first.
      if (remote && b.confirm !== true) return send(res, 428, { error: 'confirm on the phone first', confirm: true });
      try {
        const r = await deps.terminal.open(b.projectPath, mode, Number(b.cols), Number(b.rows));
        if (remote) audit(rc!.auditPath, { event: 'terminal', project: b.projectPath.slice(0, 200), session: r.session, device: device!.id });
        return send(res, 200, r);
      } catch (err) {
        return send(res, (err as { status?: number }).status ?? 500, { error: String((err as Error).message ?? err).slice(0, 300) });
      }
    }
    const im = /^\/api\/term\/([0-9a-f-]{36})\/image$/.exec(url.pathname);
    if (deps.terminal && im && req.method === 'POST') {
      const term = deps.terminal.get(im[1]!);
      if (!term) return send(res, 404, { error: 'terminal closed' });
      const ext = IMAGE_TYPES[String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()];
      if (!ext) return send(res, 415, { error: 'only PNG, JPEG, GIF or WebP images' });
      let bytes: Buffer;
      try {
        bytes = await readBytes(req, MAX_IMAGE);
      } catch {
        return send(res, 413, { error: 'image too large (15 MB max)' });
      }
      if (!bytes.length) return send(res, 400, { error: 'empty image' });
      const path = savePastedImage(bytes, ext);
      // Pasted (bracketed), the way a terminal pastes a dragged file: Claude turns the path into [Image #n].
      term.write(`\x1b[200~${path}\x1b[201~`);
      if (remote) audit(rc!.auditPath, { event: 'image', bytes: bytes.length, device: device!.id });
      return send(res, 200, { ok: true });
    }
    // A file attached from the page (the paperclip, or a dropped/pasted document): saved on the Mac
    // and its path pasted into the chat, where Claude reads it. Pictures are attached as images.
    const fm = /^\/api\/term\/([0-9a-f-]{36})\/file$/.exec(url.pathname);
    if (deps.terminal && fm && req.method === 'POST') {
      const term = deps.terminal.get(fm[1]!);
      if (!term) return send(res, 404, { error: 'terminal closed' });
      const named = attachName(String(req.headers['x-filename'] ?? ''));
      if (!named) return send(res, 415, { error: 'only pictures, PDFs, text, Word, Excel or PowerPoint files' });
      let bytes: Buffer;
      try {
        bytes = await readBytes(req, MAX_DOC);
      } catch {
        return send(res, 413, { error: 'file too large (30 MB max)' });
      }
      if (!bytes.length) return send(res, 400, { error: 'empty file' });
      const path = savePastedImage(bytes, named.ext, PASTES_DIR, named.base);
      term.write(`\x1b[200~${path} \x1b[201~`);
      if (remote) audit(rc!.auditPath, { event: 'file', ext: named.ext, bytes: bytes.length, device: device!.id });
      return send(res, 200, { ok: true, name: `${named.base}.${named.ext}` });
    }
    const tm = /^\/api\/term\/([0-9a-f-]{36})\/(stream|input|resize|close)$/.exec(url.pathname);
    if (deps.terminal && tm) {
      const term = deps.terminal.get(tm[1]!);
      if (!term) return send(res, 404, { error: 'terminal closed' });
      const what = tm[2];
      if (what === 'stream' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const off = term.subscribe(
          (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
          () => {
            res.write('event: exit\ndata: {}\n\n');
            res.end();
          },
        );
        const ping = setInterval(() => {
          if (remote && !rc!.devices.check(given)) return res.end();
          res.write(': ping\n\n');
        }, 15_000);
        req.on('close', () => {
          off();
          clearInterval(ping);
        });
        return;
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      let b: { data?: unknown; cols?: unknown; rows?: unknown; repaint?: unknown };
      try {
        b = what === 'close' ? {} : (((await readJson(req)) ?? {}) as typeof b);
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      if (what === 'input') {
        if (typeof b.data !== 'string' || b.data.length > 64 * 1024) return send(res, 400, { error: 'data must be text under 64KB' });
        term.typed(b.data); // the owner's keys: the office waits while they have an unsent message
      } else if (what === 'resize') term.resize(Number(b.cols), Number(b.rows), b.repaint === true);
      else term.close();
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  };

  const codes = new Map<string, number>();
  const serve = (remote: boolean) => (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, remote).catch((err: unknown) => {
      console.error('request failed:', err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  };
  const server = createServer(serve(false));
  if (rc) {
    // The Tailscale door: its own loopback port, opened and closed with the main one.
    const door = createServer(serve(true));
    server.on('listening', () => door.listen(rc.port, '127.0.0.1'));
    server.on('close', () => door.close());
  }
  return server;
}
