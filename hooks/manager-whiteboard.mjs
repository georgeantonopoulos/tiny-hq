#!/usr/bin/env node
// Stop hook for the manager's session (manager/.claude/settings.json): the owner reads the manager's
// notebook on the whiteboard. If a turn did something but the manager didn't write their
// notebook, the office stamps today's date on the `- Updated:` line of each project the
// turn was about (named in the message that started it, their tool calls or their replies).
// It never sends them back: sending them back cost about a million tokens a morning, for a
// line the office can write itself. The manager still writes the content. A turn that did
// nothing (only reading, or ending "(quiet)") leaves the notebook as it was.
// Prints nothing, never blocks, and leaves the notebook alone if anything can't be read.

import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TAIL = 4 * 1024 * 1024; // the last few MB of the transcript hold the current turn

function tailLines(transcript) {
  const fd = openSync(transcript, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

// What the turn since it started did: any tool call other than reading, and its last words.
export function turnDid(lines, startedAt) {
  let acted = false;
  let last = '';
  for (const l of lines) {
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (d.type !== 'assistant' || d.isSidechain || !d.timestamp || Date.parse(d.timestamp) < startedAt) continue;
    for (const c of d.message?.content ?? []) {
      if (c?.type === 'tool_use' && !['Read', 'ToolSearch', 'ListAgents', 'Grep', 'Glob'].includes(c.name)) acted = true;
      if (c?.type === 'text' && c.text?.trim()) last = c.text.trim();
    }
  }
  return { acted, quiet: last === '(quiet)' };
}

// What the turn was about, as text: the messages that reached the manager, their tool calls and
// their replies (not tool results: a job list or status page names every room).
export function turnText(lines, startedAt) {
  const out = [];
  for (const l of lines) {
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (d.isSidechain || d.isMeta || !d.timestamp || Date.parse(d.timestamp) < startedAt) continue;
    // JSON text writes a line break as the two characters \n: turn those back into spaces, or a
    // name at the start of a line ("\nAtlas") would sit right after an "n" and not count.
    const flat = (v) => JSON.stringify(v).replace(/\\[nrt]/g, ' ');
    if (d.type === 'attachment' && d.attachment?.type === 'queued_command') out.push(flat(d.attachment));
    const c = d.message?.content;
    if (d.type === 'user' && typeof c === 'string') out.push(c);
    if ((d.type === 'user' || d.type === 'assistant') && Array.isArray(c))
      for (const x of c) {
        if (x?.type === 'text' && x.text) out.push(x.text);
        if (d.type === 'assistant' && x?.type === 'tool_use') out.push(flat(x.input ?? {}));
      }
  }
  return out.join('\n');
}

// "## Atlas (Ada Lovelace)": the room's name, and its lead's without a trailing number
// ("Ada Lovelace 2" is a second session of Ada Lovelace). The room keeps its number:
// "Website 1" and "Website 2" are different projects.
function namesOf(title) {
  const m = /^(.*?)\s*(?:\((.*)\))?\s*$/.exec(title) ?? [];
  return [(m[1] ?? '').trim(), (m[2] ?? '').replace(/\s+\d+$/, '').trim()].filter((n) => n.length >= 4);
}

// The notebook with today's date on the `- Updated:` line of every section the turn named.
export function stampNotebook(md, text, today) {
  const lower = text.toLowerCase();
  const named = (title) =>
    namesOf(title).some((n) => new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(lower));
  const lines = md.split('\n');
  const out = [];
  let stamp = false; // in a section the turn was about
  let pending = false; // ...whose Updated line hasn't been seen yet
  const close = () => {
    if (pending) {
      let i = out.length;
      while (i > 0 && !out[i - 1].trim()) i--; // after its last line, before the blank ones
      out.splice(i, 0, `- Updated: ${today}`);
    }
    pending = false;
  };
  for (const line of lines) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      close();
      stamp = named(h[1].trim());
      pending = stamp;
    } else if (stamp && /^\s*[-*]\s+Updated:/i.test(line)) {
      out.push(line.replace(/Updated:.*$/i, `Updated: ${today}`));
      pending = false;
      continue;
    }
    out.push(line);
  }
  close();
  return out.join('\n');
}

export function lastPromptAt(lines) {
  {
    for (let i = lines.length - 1; i >= 0; i--) {
      let d;
      try {
        d = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (d.type !== 'user' || d.isMeta || !d.message) continue;
      const c = d.message.content;
      // The message that started the turn: text, not a tool result.
      const isPrompt = typeof c === 'string' || (Array.isArray(c) && c.some((x) => x && x.type === 'text'));
      if (isPrompt && d.timestamp) return Date.parse(d.timestamp);
    }
  }
  return undefined;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
let input = '';
if (isMain) process.stdin.setEncoding('utf8');
if (isMain) process.stdin.on('data', (c) => (input += c));
if (isMain) process.stdin.on('end', () => {
  try {
    const hook = JSON.parse(input || '{}');
    if (hook.stop_hook_active || !hook.transcript_path) return;
    const notebook = join(process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq'), 'manager', 'notebook.md');
    const lines = tailLines(hook.transcript_path);
    const startedAt = lastPromptAt(lines);
    if (!startedAt) return;
    const did = turnDid(lines, startedAt);
    if (did.quiet || !did.acted) return; // a turn that changed nothing leaves the notebook as it was
    let written = 0;
    try {
      written = statSync(notebook).mtimeMs;
    } catch {
      // no notebook yet: they should write one
    }
    if (written >= startedAt) return; // updated this turn
    const md = readFileSync(notebook, 'utf8');
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const next = stampNotebook(md, turnText(lines, startedAt), today);
    if (next === md || statSync(notebook).mtimeMs !== written) return; // the manager wrote it meanwhile: theirs wins
    const tmp = `${notebook}.stamp-${process.pid}`;
    writeFileSync(tmp, next);
    renameSync(tmp, notebook); // whole file at once: the whiteboard never reads a half-written notebook
  } catch {
    // never stand in the manager's way over a hook problem
  }
});
