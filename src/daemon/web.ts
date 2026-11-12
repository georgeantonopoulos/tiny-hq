// Serves the office page. No build step: .ts files under web/ are stripped of
// their types by Node on the way out. Only files inside web/ and the PixiJS
// browser bundle can be served; nothing else on disk is reachable.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { REPO_ROOT } from '../paths.ts';

export const WEB_ROOT = join(REPO_ROOT, 'web');
// PixiJS as classic scripts: the main bundle plus its "unsafe-eval" add-on, which
// (despite the name) replaces PixiJS's use of eval, so the page can forbid eval.
const PIXI_DIST = join(REPO_ROOT, 'node_modules', 'pixi.js', 'dist');
const VENDOR: Record<string, string> = {
  '/vendor/pixi.js': join(PIXI_DIST, 'pixi.min.js'),
  '/vendor/pixi-no-eval.js': join(PIXI_DIST, 'packages', 'unsafe-eval.min.js'),
  // The project terminal: xterm.js and its fit add-on, as classic scripts.
  '/vendor/xterm.js': join(REPO_ROOT, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'),
  '/vendor/xterm.css': join(REPO_ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/xterm-fit.js': join(REPO_ROOT, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// The page loads nothing from anywhere but this daemon.
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
};

const cache = new Map<string, { mtime: number; body: string }>();

function load(file: string): string {
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.body;
  let body = readFileSync(file, 'utf8');
  if (file.endsWith('.ts')) body = stripTypeScriptTypes(body, { mode: 'strip' });
  cache.set(file, { mtime, body });
  return body;
}

// Returns true if it handled the request.
export function serveStatic(pathname: string, res: ServerResponse): boolean {
  let file: string;
  if (pathname === '/' || pathname === '/index.html') file = join(WEB_ROOT, 'index.html');
  else if (pathname === '/favicon.ico') file = join(WEB_ROOT, 'icon-32.png'); // browsers ask for this by default
  else if (VENDOR[pathname]) file = VENDOR[pathname];
  else if (pathname.startsWith('/app/') || pathname === '/style.css' || pathname === '/thumbnail.png' || /^\/icon(-\d+)?\.(png|svg)$/.test(pathname)) {
    try {
      file = join(WEB_ROOT, decodeURIComponent(pathname));
    } catch {
      return notFound(res); // malformed %-escape
    }
  } else return false;

  const type = TYPES[extname(file)];
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return notFound(res);
  }
  // node_modules entries are symlinks (pnpm), so compare resolved paths.
  const isVendor = Object.values(VENDOR).some((v) => {
    try {
      return realpathSync(v) === real;
    } catch {
      return false;
    }
  });
  const allowed = isVendor || real.startsWith(realpathSync(WEB_ROOT) + sep);
  if (!type || !allowed) return notFound(res);

  res.writeHead(200, { 'content-type': type, ...SECURITY_HEADERS });
  // Pictures go out as the raw bytes; reading them as text would corrupt them.
  res.end(extname(real) === '.png' ? readFileSync(real) : load(real));
  return true;
}

function notFound(res: ServerResponse): true {
  res.writeHead(404, { 'content-type': 'text/plain', ...SECURITY_HEADERS });
  res.end('not found');
  return true;
}
