// The owner's desk: reports they asked for, waiting for them as readable pages, not lost in a
// chat bubble. The manager and rooms file a
// report with `manager/desk add`; the office lists them newest first, marks unread ones, and shows
// each as a page. Reports are Markdown, turned into HTML here: everything is escaped first and
// only a small set of tags is made, so nothing a session writes can run in the office page.
// Files: <dataDir>/desk/index.json and <dataDir>/desk/<id>.md.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Report {
  id: string;
  title: string;
  from: string; // who filed it (The manager, or a room's person)
  at: number;
  read?: number; // when the owner first opened it
}

const ID = /^[a-z0-9]{8,16}$/;
const oneLine = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const deskDir = (dataDir: string) => join(dataDir, 'desk');

export function listReports(dataDir: string): Report[] {
  try {
    const raw = JSON.parse(readFileSync(join(deskDir(dataDir), 'index.json'), 'utf8')) as Report[];
    return (Array.isArray(raw) ? raw : []).filter((r) => r && ID.test(r.id) && typeof r.title === 'string').sort((a, b) => b.at - a.at);
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

export function fileReport(dataDir: string, title: string, markdown: string, from: string, now = Date.now(), id = Math.random().toString(36).slice(2, 10).padEnd(8, '0')): Report {
  const t = oneLine(title, 140);
  if (!t) throw new Error('a report needs a title');
  if (!markdown.trim()) throw new Error('the report is empty');
  if (markdown.length > 400_000) throw new Error('the report is too long (400 KB at most)');
  const dir = deskDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${id}.md`), markdown, { mode: 0o600 });
  const r: Report = { id, title: t, from: oneLine(from, 60) || 'the office', at: now };
  saveIndex(dataDir, [r, ...listReports(dataDir).filter((x) => x.id !== id)].slice(0, 500));
  return r;
}

// One report as a page, marked read the first time the owner opens it.
export function openReport(dataDir: string, id: string, now = Date.now()): (Report & { html: string }) | undefined {
  if (!ID.test(id)) return undefined;
  const list = listReports(dataDir);
  const r = list.find((x) => x.id === id);
  const file = join(deskDir(dataDir), `${id}.md`);
  if (!r || !existsSync(file)) return undefined;
  if (!r.read) saveIndex(dataDir, list.map((x) => (x.id === id ? { ...x, read: now } : x)));
  return { ...r, read: r.read ?? now, html: renderMarkdown(readFileSync(file, 'utf8')) };
}

export const unreadCount = (dataDir: string): number => listReports(dataDir).filter((r) => !r.read).length;

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
