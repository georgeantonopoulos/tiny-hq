// The owner's desk: reports they asked for, waiting for them as readable pages, not lost in a
// chat bubble. The manager and rooms file a report with `manager/desk add`; the office shows them
// as a folder tree, newest first, unread ones marked. Reports are Markdown, turned into HTML here:
// everything is escaped first and only a small set of tags is made, so nothing a session writes
// can run in the office page.
//
// Each report is a real file, <root>/<folder>/<title> (<date>).md, grouped by what it is, so the
// reports outlive the office and can sit in a synced folder (iCloud Drive, Dropbox, Google Drive)
// that is backed up online. <root> is named in <dataDir>/desk/where.json ({"root": "/abs/path"},
// set with `desk where`); without it the folders stay inside the office's own data. The tree on
// the page is whatever is on disk: folders the owner makes, renames or fills in Finder show up
// too. The office keeps only who filed each report and whether the owner has read it, in
// <dataDir>/desk/index.json (by id, with the file's path under <root>). Reports filed before
// folders were flat <dataDir>/desk/<id>.md files; `copyFlatReports` copies them into the tree and
// leaves the originals where they were, so nothing is lost and old ids keep opening.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

export interface Report {
  id: string;
  title: string;
  from: string; // who filed it (the manager, or a room's person); '' for a file the owner put there themselves
  at: number;
  read?: number; // when the owner first opened it
  path?: string; // the file under the desk folder, '/'-separated; missing while it's only in the office
}

// What the page gets: a report and the folder it sits in ('' for the top of the desk).
export type DeskEntry = Report & { folder: string };

const ID = /^[a-z0-9]{8,16}$/;
const oneLine = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const deskDir = (dataDir: string) => join(dataDir, 'desk');

// The synced folder the reports live in. Without where.json they stay inside the office's own data.
export function deskRoot(dataDir: string): string {
  try {
    const w = JSON.parse(readFileSync(join(deskDir(dataDir), 'where.json'), 'utf8')) as { root?: unknown };
    if (typeof w.root === 'string' && w.root.startsWith('/')) return w.root;
  } catch {}
  return join(deskDir(dataDir), 'folders');
}

// The desk folder as the page shows it: the synced drive's own name rather than its long path.
export function shortRoot(root: string, home: string): string {
  return root
    .replace(/^.*\/Library\/Mobile Documents\/com~apple~CloudDocs(\/|$)/, 'iCloud Drive$1')
    .replace(/^.*\/Library\/CloudStorage\/GoogleDrive-[^/]+\//, 'Google Drive/')
    .replace(/^.*\/Library\/CloudStorage\/Dropbox[^/]*\//, 'Dropbox/')
    .replace(home, '~');
}

// ---- Which folder a report goes in: what it is ----

const KINDS: [RegExp, string][] = [
  [/\bevening note\b/i, 'Evening notes'],
  [/\bsecurity\b|\bscan\b|vulnerab|\bCVE\b/i, 'Security'],
  [/\bsales\b|revenue|\btax\b|invoice|payment|\bmoney\b|spending|\bbank\b|\bbudget\b|\bVAT\b|\bexpenses?\b/i, 'Money and sales'],
  [/release|changes? since|changelog|what changed|what broke|\bchanges\b|\bupdates?\b|\bv\d+\.\d+/i, 'Releases and changes'],
  [/\boffice\b|\bmanager\b|tidy-up|\busage\b/i, 'Office'],
];

export function folderFor(title: string, from = ''): string {
  for (const [re, folder] of KINDS) if (re.test(title)) return folder;
  if (/^(the )?(manager|office)$/i.test(from)) return 'Office';
  return 'Research and answers';
}

// A folder or file name that is safe on every disk and synced drive: no slashes, no leading dot.
const safeName = (s: string, n: number) =>
  oneLine(s.normalize('NFC'), n)
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/^[.\s-]+/, '')
    .trim();

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

// ---- The index: who filed what, and what the owner has read ----

function loadIndex(dataDir: string): Report[] {
  try {
    const raw = JSON.parse(readFileSync(join(deskDir(dataDir), 'index.json'), 'utf8')) as Report[];
    return (Array.isArray(raw) ? raw : []).filter((r) => r && ID.test(r.id) && typeof r.title === 'string');
  } catch {
    return [];
  }
}

function saveIndex(dataDir: string, list: Report[]): void {
  const dir = deskDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `index.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, join(dir, 'index.json'));
}

// Every folder and Markdown file under the desk folder, '/'-separated. Symlinks and hidden names
// are skipped, so nothing outside the folder can be pulled in.
function scan(root: string, depth = 4): { files: string[]; folders: string[] } {
  const files: string[] = [];
  const folders: string[] = [];
  const walk = (dir: string, rel: string, d: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      let st;
      try {
        st = lstatSync(join(dir, n));
      } catch {
        continue;
      }
      const r = (rel ? `${rel}/${n}` : n).normalize('NFC'); // same form as the titles the index keeps
      if (st.isDirectory() && d > 0) {
        folders.push(r);
        walk(join(dir, n), r, d - 1);
      } else if (st.isFile() && /\.md$/i.test(n)) files.push(r);
    }
  };
  walk(root, '', depth);
  return { files, folders: folders.sort((a, b) => a.localeCompare(b)) };
}

const idForPath = (path: string) => createHash('sha1').update(path).digest('hex').slice(0, 12);
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// The desk as it is on disk, matched to the index. A report moved to another folder in Finder keeps
// its title and read mark (matched by file name); a file the owner put there themselves is listed under
// its file name. Newest first.
export function listDesk(dataDir: string): { root: string; folders: string[]; reports: DeskEntry[] } {
  const root = deskRoot(dataDir);
  const index = loadIndex(dataDir);
  const { files, folders } = scan(root);
  const onDisk = new Set(files);
  const byPath = new Map(index.filter((r) => r.path).map((r) => [r.path!, r]));
  const out: DeskEntry[] = [];
  const moved = new Map<string, string>(); // id -> its new path
  for (const f of files) {
    let r = byPath.get(f);
    if (!r) {
      // Moved, or its folder renamed, in Finder: the same file name, its old path gone.
      const name = basename(f);
      r = index.find((x) => x.path && basename(x.path) === name && !onDisk.has(x.path));
      if (r) {
        byPath.delete(r.path!);
        r.path = f;
        byPath.set(f, r);
        moved.set(r.id, f);
      }
    }
    if (r) {
      out.push({ ...r, folder: folderOf(f) });
      continue;
    }
    let at = Date.now();
    try {
      at = statSync(join(root, f)).mtimeMs;
    } catch {}
    out.push({ id: idForPath(f), title: basename(f).replace(/\.md$/i, ''), from: '', at, read: at, path: f, folder: folderOf(f) });
  }
  // Reports still only in the office (the synced folder wasn't there when they were filed).
  for (const r of index) if (!r.path && existsSync(join(deskDir(dataDir), `${r.id}.md`))) out.push({ ...r, folder: '' });
  // Re-read just before saving, so a report another process filed meanwhile isn't dropped.
  if (moved.size) saveIndex(dataDir, loadIndex(dataDir).map((x) => (moved.has(x.id) ? { ...x, path: moved.get(x.id) } : x)));
  return { root, folders, reports: out.sort((a, b) => b.at - a.at) };
}

export const listReports = (dataDir: string): DeskEntry[] => listDesk(dataDir).reports;

// Where a new report's file goes: <folder>/<title> (<date>).md, never over another file.
function placeFor(root: string, folder: string, title: string, at: number, id: string): string {
  const f =
    folder
      .split('/')
      .map((p) => safeName(p, 60))
      .filter(Boolean)
      .join('/') || 'Research and answers';
  const name = safeName(title, 100) || 'Report';
  const path = `${f}/${name} (${ymd(at)}).md`;
  return existsSync(join(root, path)) ? `${f}/${name} (${ymd(at)}, ${id}).md` : path;
}

export function fileReport(dataDir: string, title: string, markdown: string, from: string, now = Date.now(), id = Math.random().toString(36).slice(2, 10).padEnd(8, '0'), folder?: string): Report {
  const t = oneLine(title, 140);
  if (!t) throw new Error('a report needs a title');
  if (!markdown.trim()) throw new Error('the report is empty');
  if (markdown.length > 400_000) throw new Error('the report is too long (400 KB at most)');
  const who = oneLine(from, 60) || 'the office';
  const root = deskRoot(dataDir);
  const r: Report = { id, title: t, from: who, at: now };
  try {
    if (!existsSync(dirname(root))) throw new Error('the synced drive is not there');
    const path = placeFor(root, folder?.trim() || folderFor(t, who), t, now, id);
    mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, path), markdown, { mode: 0o600 });
    r.path = path;
  } catch {
    // The synced drive isn't there (not running, or unplugged): keep it in the office; copyFlatReports moves it over later.
    mkdirSync(deskDir(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(join(deskDir(dataDir), `${id}.md`), markdown, { mode: 0o600 });
  }
  saveIndex(dataDir, [r, ...loadIndex(dataDir).filter((x) => x.id !== id)].slice(0, 2000));
  return r;
}

// Reports that are only in the office (filed before the folders, or while the drive was away)
// copied into the tree, each into the folder for what it is. The originals stay where they were.
// Returns how many were copied.
export function copyFlatReports(dataDir: string): number {
  const root = deskRoot(dataDir);
  if (!existsSync(dirname(root))) return 0; // the synced drive isn't there: try again later
  const index = loadIndex(dataDir);
  let n = 0;
  for (const r of index) {
    if (r.path) continue;
    const src = join(deskDir(dataDir), `${r.id}.md`);
    if (!existsSync(src)) continue;
    try {
      const path = placeFor(root, folderFor(r.title, r.from), r.title, r.at, r.id);
      mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
      copyFileSync(src, join(root, path));
      r.path = path;
      n++;
    } catch {}
  }
  if (n) saveIndex(dataDir, index);
  return n;
}

// Points the desk at a new folder and copies the reports already filed in the old one across,
// at the same place in the tree, so none drop off the page. The old files stay where they were.
// Refuses a folder whose parent isn't there (a synced drive that isn't mounted, a typo).
export function moveDesk(dataDir: string, to: string): number {
  if (!existsSync(dirname(to))) throw new Error(`${dirname(to)} isn't there`);
  const from = deskRoot(dataDir);
  mkdirSync(deskDir(dataDir), { recursive: true, mode: 0o700 });
  writeFileSync(join(deskDir(dataDir), 'where.json'), JSON.stringify({ root: to }, null, 2) + '\n', { mode: 0o600 });
  let n = 0;
  if (from !== to) {
    for (const r of loadIndex(dataDir)) {
      if (!r.path) continue;
      const src = join(from, r.path);
      const dst = join(to, r.path);
      try {
        if (!lstatSync(src).isFile() || existsSync(dst)) continue;
        mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
        copyFileSync(src, dst);
        n++;
      } catch {}
    }
  }
  return n + copyFlatReports(dataDir);
}

// The file behind a report, only if it really is inside the desk folder (no symlinks out of it).
function fileOf(dataDir: string, r: Report): string | undefined {
  try {
    if (!r.path) {
      const flat = join(deskDir(dataDir), `${r.id}.md`);
      return existsSync(flat) ? flat : undefined;
    }
    const root = deskRoot(dataDir);
    const full = join(root, r.path);
    if (lstatSync(full).isSymbolicLink()) return undefined;
    const real = realpathSync(full);
    return real.startsWith(realpathSync(root) + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

// One report as a page, marked read the first time the owner opens it.
export function openReport(dataDir: string, id: string, now = Date.now()): (DeskEntry & { html: string }) | undefined {
  if (!ID.test(id)) return undefined;
  const r = listDesk(dataDir).reports.find((x) => x.id === id);
  if (!r) return undefined;
  const file = fileOf(dataDir, r);
  if (!file) return undefined;
  const index = loadIndex(dataDir);
  if (index.some((x) => x.id === id && !x.read)) saveIndex(dataDir, index.map((x) => (x.id === id ? { ...x, read: now } : x)));
  return { ...r, read: r.read ?? now, html: renderMarkdown(readFileSync(file, 'utf8')) };
}

// Asked on every status poll, so it reads the index and checks only the unread files, rather than
// walking the whole synced folder. A file the owner put there themselves is never unread.
export function unreadCount(dataDir: string): number {
  const root = deskRoot(dataDir);
  return loadIndex(dataDir).filter((r) => !r.read && existsSync(r.path ? join(root, r.path) : join(deskDir(dataDir), `${r.id}.md`))).length;
}

// ---- Markdown to HTML: headings, paragraphs, lists, tables, quotes, code, bold, italics, links ----

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inline(text: string): string {
  const codes: string[] = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  // Links: http(s) and mailto only, opened in a new tab.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => (/^(https?:|mailto:)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : m));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (/^```/.test(l)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (isRow(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = cells(l);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && isRow(lines[i]!); i++) rows.push(cells(lines[i]!));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!); i++) items.push(`<li>${inline(lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ''))}</li>`);
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) q.push(lines[i]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!) && !isRow(lines[i]!); i++) para.push(lines[i]!);
    if (!para.length) para.push(lines[i++]!); // a stray table row: show it as text
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
