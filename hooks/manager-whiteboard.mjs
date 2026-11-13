#!/usr/bin/env node
// Stop hook for the manager's session (manager/.claude/settings.json): the owner reads the manager's
// notebook on the whiteboard, so it must be current after every turn. If the manager
// ends a turn without having written their notebook since the message that started
// it, they are sent back once to bring it up to date (done items out, a fresh Next).
// The second stop always goes through (stop_hook_active), so it can never loop. A turn that did
// nothing (only reading, or ending "(quiet)") leaves the notebook as it was and isn't sent back.
// Prints nothing, and never blocks, if anything here can't be read.

import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
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
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          "Whiteboard check (the office, after a turn that did something): you haven't written your notebook this turn, and the owner reads it on your whiteboard. Re-read it against what this turn changed and your status page: take out anything done or handled, refresh that project's `- Next:` and `- Updated:`. If nothing on it is out of date, reply with exactly (quiet) and nothing else.",
      }),
    );
  } catch {
    // never stand in the manager's way over a hook problem
  }
});
