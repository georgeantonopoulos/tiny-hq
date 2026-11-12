// The welcome page: `tiny-hq setup` opens it in the browser. A small server just for setup, on this
// Mac only (127.0.0.1, a free port), with a one-time key in the link; it closes once the owner presses
// "Open my office". It serves only the files in web/welcome and three calls:
//   GET  /api/welcome        the suggested answers, the extras and Claude Code helpers to switch on or off
//   GET  /api/welcome/rooms  the projects found, for picking rooms (a scan can take a few seconds)
//   POST /api/welcome/finish the answers; replies with the office's link once it's set up and running

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, sep } from 'node:path';
import { STYLES } from '../config.ts';
import { SECURITY_HEADERS, WEB_ROOT } from '../daemon/web.ts';
import { HOOKS } from './install.ts';
import { cleanChoices, currentChoices, has, offeredRooms, tilde, type Offered, type SetupChoices } from './setup.ts';

const ROOT = join(WEB_ROOT, 'welcome');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ts': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// What each extra and helper is, in the words the page shows.
const EXTRAS = [
  { id: 'github', title: 'GitHub keeper', what: "Keeps an eye on your GitHub projects and tells you when someone else opens a pull request, an issue or a comment." },
  { id: 'coffee', title: 'Coffee room', what: 'A few times a day, two or three rooms meet for coffee and share what they learned. Each chat is one small, cheap Claude call.' },
  { id: 'happenings', title: 'Office happenings', what: 'Little moments around the office: a plant gets watered, someone loses a stapler. Written about once a day.' },
  { id: 'briefing', title: 'Morning brief', what: 'Each morning your manager sums up what happened and what needs you today.' },
  { id: 'login', title: 'Open when I log in', what: 'The office starts by itself when you log in to your Mac, so it is always there.' },
] as const;
// The Claude Code helpers, in plain words (the typed setup shows each hook's own consent line).
const HELPER_WORDS: Record<string, string> = {
  'name-tag': "When you open Claude in one of your projects, it's told which room it's in and who its manager is.",
  waiting: 'When Claude stops to ask your permission, a little hand goes up over that room so you notice.',
  'public-posts': 'Before Claude posts anything public (a GitHub comment, a social post), it stops and asks you, showing exactly what it would say.',
};
const HELPERS = [
  ...HOOKS.map((h) => ({ id: h.id, title: h.what.split(':')[0]!, what: HELPER_WORDS[h.id] ?? h.what })),
  { id: 'skill', title: 'Office guide', what: "A short guide every room's Claude reads, so it knows how the office works and who to report to." },
];

export interface WelcomeResult {
  url?: string; // the office, signed in
  error?: string;
  notes?: string[];
}

// Runs the page until the owner finishes. `finish` saves the answers and starts the office.
export function runWelcome(finish: (ch: SetupChoices, offered: Offered[]) => Promise<WelcomeResult>, onReady: (url: string) => void): Promise<void> {
  const key = randomBytes(24).toString('base64url');
  let offered: Offered[] | undefined;
  let scanning: Promise<Offered[]> | undefined;
  let scans = 0;
  const scan = (roots: string[]) => {
    const n = ++scans;
    scanning = offeredRooms(roots)
      .catch(() => [] as Offered[])
      .then((o) => {
        if (n === scans) offered = o; // an older scan finishing late never replaces a newer one
        return o;
      });
    return scanning;
  };
  scan(currentChoices().projectRoots); // start looking straight away; the page asks for it in step 4
  let done!: () => void;
  const over = new Promise<void>((r) => (done = r));
  let finishing = false;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        if (!keyOk(req, key)) return send(res, 401, { error: 'This setup link has expired. Run tiny-hq setup again.' });
        if (req.method === 'GET' && url.pathname === '/api/welcome') {
          const c = currentChoices();
          return send(res, 200, { choices: c, roots: c.projectRoots.map(tilde), styles: STYLES, extras: EXTRAS, helpers: HELPERS, gh: has('gh') });
        }
        if (req.method === 'GET' && url.pathname === '/api/welcome/rooms') {
          const more = url.searchParams.get('roots');
          if (more !== null) {
            const c = cleanChoices({ projectRoots: more.split('\n') }, []);
            if (typeof c !== 'string') await scan(c.projectRoots);
          }
          return send(res, 200, { rooms: await scanning });
        }
        if (req.method === 'POST' && url.pathname === '/api/welcome/finish') {
          if (finishing) return send(res, 409, { error: 'Already setting up.' });
          const body = await readJson(req);
          const list = offered ?? (await scanning) ?? [];
          const ch = cleanChoices(body, list.map((o) => o.path));
          if (typeof ch !== 'string' && (!list.length || !(body as { rooms?: unknown })?.rooms)) delete ch.rooms;
          if (typeof ch === 'string') return send(res, 400, { error: ch });
          finishing = true;
          let r: WelcomeResult;
          try {
            r = await finish(ch, offered ?? []);
          } catch (err) {
            r = { error: err instanceof Error ? err.message : String(err) };
          } finally {
            finishing = false; // a failed try can be tried again
          }
          send(res, r.error ? 500 : 200, r);
          // Close once the reply is out; open keep-alive connections would hold the server (and setup) open.
          if (!r.error) setTimeout(() => {
            server.close(() => done());
            server.closeAllConnections();
          }, 500);
          return;
        }
        return send(res, 404, { error: 'not found' });
      }
      return serveFile(url.pathname, res);
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    onReady(`http://127.0.0.1:${port}/#key=${key}`);
  });
  return over;
}

function keyOk(req: IncomingMessage, key: string): boolean {
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c;
      if (raw.length > 200_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
  });
}

// Only files in web/welcome, plus the office icon.
function serveFile(pathname: string, res: ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = rel === 'icon.svg' ? join(WEB_ROOT, 'icon.svg') : join(ROOT, rel);
  try {
    file = realpathSync(file);
  } catch {
    return notFound(res);
  }
  const type = TYPES[extname(file)];
  if (!type || !(file.startsWith(realpathSync(ROOT) + sep) || file === realpathSync(join(WEB_ROOT, 'icon.svg')))) return notFound(res);
  res.writeHead(200, { 'content-type': type, ...SECURITY_HEADERS });
  if (extname(file) === '.png') return void res.end(readFileSync(file));
  const text = readFileSync(file, 'utf8');
  res.end(file.endsWith('.ts') ? stripTypeScriptTypes(text, { mode: 'strip' }) : text);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain', ...SECURITY_HEADERS });
  res.end('not found');
}
