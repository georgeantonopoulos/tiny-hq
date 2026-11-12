#!/usr/bin/env node
// Stop hook for the manager's session (manager/.claude/settings.json): the owner reads the manager's
// notebook on the whiteboard, so it must be current after every turn. If the manager
// ends a turn without having written their notebook since the message that started
// it, they are sent back once to bring it up to date (done items out, a fresh Next).
// The second stop always goes through (stop_hook_active), so it can never loop.
// Prints nothing, and never blocks, if anything here can't be read.

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TAIL = 4 * 1024 * 1024; // the last few MB of the transcript hold the current turn

function lastPromptAt(transcript) {
  const fd = openSync(transcript, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
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
  } finally {
    closeSync(fd);
  }
  return undefined;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const hook = JSON.parse(input || '{}');
    if (hook.stop_hook_active || !hook.transcript_path) return;
    const notebook = join(process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq'), 'manager', 'notebook.md');
    const startedAt = lastPromptAt(hook.transcript_path);
    if (!startedAt) return;
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
          "Whiteboard check (the office, after every turn): you haven't written your notebook this turn, and the owner reads it on your whiteboard. Re-read it against what this turn changed and your status page: take out anything done or handled, refresh that project's `- Next:` and `- Updated:`. If nothing on it is out of date, reply with exactly (quiet) and nothing else.",
      }),
    );
  } catch {
    // never stand in the manager's way over a hook problem
  }
});
