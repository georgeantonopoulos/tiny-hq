// Quick links: a row of taskbar-style icons along the bottom of the floor, each opening a page the
// owner uses (the Claude usage page, GitHub, a dashboard...). The list lives in
// ~/.tiny-hq/links.json and is read on every request, so a change shows without a restart.
// `{here}` in a link stands for the address Tiny HQ page itself was opened at: 127.0.0.1 at the
// Mac, the Mac's remote name on a phone, so a page served on the Mac opens from both.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface QuickLink {
  name: string;
  url: string;
  emoji: string; // shown when the site has no icon of its own (or it can't be fetched)
  iconUrl?: string; // the icon to use when the site's own page doesn't name a good one
  // A program on this Mac that serves the link's page (a local dashboard, say): argv, the
  // first item an absolute path. Clicking the icon starts it when the page isn't answering. Only
  // links.json names it; the page is told just `launchable`.
  launch?: string[];
}

export const DEFAULT_LINKS: QuickLink[] = [
  { name: 'Usage', url: 'https://claude.ai/settings/usage', emoji: '📊' },
  { name: 'GitHub', url: 'https://github.com/', emoji: '🐙' },
];

const okUrl = (u: string) => /^https?:\/\//i.test(u) && u.length <= 2000;
const okLaunch = (a: unknown): a is string[] =>
  Array.isArray(a) && a.length > 0 && a.length <= 16 && a.every((x) => typeof x === 'string' && x.length <= 1000) && (a[0] as string).startsWith('/');

// The list, written out with the defaults the first time so the owner (or your manager) can edit it.
export function loadLinks(file: string): QuickLink[] {
  if (!existsSync(file)) {
    try {
      writeFileSync(file, JSON.stringify({ links: DEFAULT_LINKS }, null, 2) + '\n');
    } catch {
      /* read-only: the defaults still show */
    }
    return DEFAULT_LINKS;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { links?: unknown };
    if (!Array.isArray(raw.links)) return [];
    return raw.links
      .filter((l): l is QuickLink => !!l && typeof l === 'object' && typeof (l as QuickLink).name === 'string' && typeof (l as QuickLink).url === 'string' && okUrl((l as QuickLink).url))
      .slice(0, 24)
      .map((l) => ({
        name: l.name.slice(0, 40),
        url: l.url,
        emoji: typeof l.emoji === 'string' && l.emoji ? l.emoji.slice(0, 8) : '🔗',
        ...(typeof l.iconUrl === 'string' && okUrl(l.iconUrl) ? { iconUrl: l.iconUrl } : {}),
        ...(okLaunch(l.launch) ? { launch: l.launch } : {}),
      }));
  } catch {
    return [];
  }
}

// The address the daemon itself fetches an icon from: `{here}` is this Mac.
export const fetchUrl = (url: string) => url.replace(/\{here\}/g, '127.0.0.1');

// A site's own icon as a data: URL, kept on disk a week (a miss is kept a day), so the page shows
// the real GitHub cat. Fetched from the link's own site, or the icon address its
// entry names.
const WEEK = 7 * 24 * 3600_000;
const DAY = 24 * 3600_000;
const MAX_ICON = 512 * 1024;

export function iconPath(dir: string, url: string): string {
  return join(dir, createHash('sha256').update(new URL(fetchUrl(url)).origin).digest('hex').slice(0, 24) + '.json');
}

export function cachedIcon(dir: string, url: string, now = Date.now()): { icon?: string; fresh: boolean } {
  try {
    const f = iconPath(dir, url);
    const c = JSON.parse(readFileSync(f, 'utf8')) as { icon?: string };
    const age = now - statSync(f).mtimeMs;
    return { icon: c.icon, fresh: age < (c.icon ? WEEK : DAY) };
  } catch {
    return { fresh: false };
  }
}

// The icon links a page names, best first: a large touch icon, then any rel=icon, then /favicon.ico.
export function iconCandidates(html: string, base: string): string[] {
  const out: { href: string; score: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !/\bicon\b/.test(rel) || href.startsWith('data:,')) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    const score = (rel.includes('apple-touch') ? 1000 : 0) + (size || 32) + (/\.svg(\?|$)/i.test(href) ? 500 : 0);
    try {
      out.push({ href: new URL(href, base).href, score });
    } catch {
      /* a broken href */
    }
  }
  out.sort((a, b) => b.score - a.score);
  return [...out.map((o) => o.href), new URL('/favicon.ico', base).href];
}

async function get(url: string, ms: number): Promise<Response | undefined> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) office-links' } });
  } catch {
    return undefined;
  }
}

export async function fetchIcon(dir: string, url: string, iconUrl?: string): Promise<string | undefined> {
  mkdirSync(dir, { recursive: true });
  const page = fetchUrl(url);
  let icon: string | undefined;
  const r = await get(page, 5000);
  const html = r?.ok && /html/i.test(r.headers.get('content-type') ?? '') ? (await r.text().catch(() => '')).slice(0, 200_000) : '';
  for (const cand of [...(iconUrl ? [iconUrl] : []), ...iconCandidates(html, r?.url || page).slice(0, 4)]) {
    const ir = await get(cand, 5000);
    const type = (ir?.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!ir?.ok || !/^image\//.test(type)) continue;
    const buf = Buffer.from(await ir.arrayBuffer());
    if (!buf.length || buf.length > MAX_ICON) continue;
    icon = `data:${type};base64,${buf.toString('base64')}`;
    break;
  }
  try {
    writeFileSync(iconPath(dir, url), JSON.stringify({ icon }));
  } catch {
    /* no cache: tried again next time */
  }
  return icon;
}

// For the page: every link with its icon if one is on disk; stale or missing ones are fetched in
// the background and show on the next load.
const inFlight = new Set<string>();
export function linksForPage(file: string, iconDir: string): (QuickLink & { icon?: string })[] {
  return loadLinks(file).map((l) => {
    const c = cachedIcon(iconDir, l.url);
    if (!c.fresh && !inFlight.has(l.url)) {
      inFlight.add(l.url);
      void fetchIcon(iconDir, l.url, l.iconUrl).finally(() => inFlight.delete(l.url));
    }
    const { iconUrl: _, launch, ...rest } = l;
    const shown = launch ? { ...rest, launchable: true } : rest;
    return c.icon ? { ...shown, icon: c.icon } : shown;
  });
}

// Starting a link's program (see `launch` above). If its page already answers, nothing starts.
// Otherwise the program runs in its own process group (detached), so restarting Tiny HQ never
// takes it down, and Tiny HQ never stops it: the program owns its own shutdown (a program that
// talks to a device may need SIGINT/SIGTERM to let it go, never kill -9). Output goes to
// <logDir>/<name>.log. Resolves once the page answers, or with an error after `waitMs`.
const answers = async (url: string) => {
  try {
    await fetch(fetchUrl(url), { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};
type LaunchResult = { ok: boolean; started: boolean; error?: string };
const starting = new Map<string, Promise<LaunchResult>>();
export function launchLink(file: string, logDir: string, name: string, waitMs = 20_000): Promise<LaunchResult> {
  const argv = loadLinks(file).find((l) => l.name === name && l.launch);
  if (!argv?.launch) return Promise.resolve({ ok: false, started: false, error: 'no such program link' });
  const running = starting.get(name);
  if (running) return running;
  const [cmd, ...args] = argv.launch as [string, ...string[]];
  const run = (async (): Promise<LaunchResult> => {
    if (await answers(argv.url)) return { ok: true, started: false };
    if (!existsSync(cmd)) return { ok: false, started: false, error: `${cmd} is missing` };
    mkdirSync(logDir, { recursive: true });
    const log = openSync(join(logDir, name.replace(/[^\w.-]/g, '_') + '.log'), 'a');
    const child = spawn(cmd, args, { detached: true, stdio: ['ignore', log, log], cwd: dirname(cmd) });
    closeSync(log);
    let exited: number | null | undefined;
    child.on('exit', (code) => (exited = code));
    child.on('error', () => (exited = -1));
    child.unref();
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      if (await answers(argv.url)) return { ok: true, started: true };
      if (exited !== undefined) return { ok: false, started: true, error: `it stopped (exit ${exited}); see its log` };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, started: true, error: 'started, but its page is not answering yet' };
  })().finally(() => starting.delete(name));
  starting.set(name, run);
  return run;
}
