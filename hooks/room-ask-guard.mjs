#!/usr/bin/env node
// Stop hook for every room of the office (global, in ~/.claude/settings.json): a question to the
// owner is a button, never a line in chat. A question asked only in a room's chat shows no question
// mark over its head, so the owner may never see it. If a room ends a turn asking the owner
// something and didn't put up a button (manager/ask or job wait) this turn, it is sent back once
// to do that. The manager's own folder has its own check (manager-ask-guard.mjs).
//
// Only for a session whose project has an office name tag (<data>/tags/), worktrees included.
// Sent back once per turn. Never blocks if anything can't be read.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { askedWithButton, lastReply, questionsOwner, thisTurn } from './manager-ask-guard.mjs';

const DATA = process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq');
const MANAGER = join(dirname(fileURLToPath(import.meta.url)), '..', 'manager');

// The room's project folder for a session folder: a worktree counts as its project.
export const roomFolder = (dir) => dir.replace(/\/\.claude\/worktrees\/.*$/, '');
// The name tag's file, named the way Claude Code names project folders (as office-name.sh does).
export const tagFile = (dir, data = DATA) => join(data, 'tags', `${roomFolder(dir).replace(/[^a-zA-Z0-9]/g, '-')}.md`);
export function isRoom(dir, data = DATA, manager = MANAGER) {
  if (!dir) return false;
  const root = roomFolder(dir);
  if (root === manager || root.endsWith('/.tiny-hq/app/manager')) return false; // the manager: its own hook
  return existsSync(tagFile(dir, data));
}

export const REASON =
  'Question check (the office): your reply asks the owner a question in chat, so no question mark shows over your head and they may never see it. A question to them is a button: run ~/.tiny-hq/app/manager/ask "<the question>" --why <send|post|pay|choice|permission|hands|password> --tried "<what you tried>" (add --choices "<a>" "<b>" for options), and take down any older button of yours it replaces (manager/ask list, manager/ask cancel <id>). Then reply again, saying the question is on the button. If it was only rhetorical, say it as a statement.';

const NOTE = join(DATA, 'room-ask-guard.json');
function sentBack(transcript, key) {
  let notes = {};
  try {
    notes = JSON.parse(readFileSync(NOTE, 'utf8')) ?? {};
  } catch {
    // first time
  }
  if (notes[transcript] === key) return true;
  notes[transcript] = key;
  const keep = Object.fromEntries(Object.entries(notes).slice(-200));
  try {
    mkdirSync(dirname(NOTE), { recursive: true, mode: 0o700 });
    writeFileSync(NOTE, JSON.stringify(keep), { mode: 0o600 });
  } catch {
    // best effort: at worst a room is asked once more
  }
  return false;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    try {
      const hook = JSON.parse(input || '{}');
      const dir = process.env.CLAUDE_PROJECT_DIR || hook.cwd || '';
      if (!hook.transcript_path || !isRoom(dir)) return;
      const lines = readFileSync(hook.transcript_path, 'utf8').split('\n').slice(-4000);
      const turn = thisTurn(lines);
      const reply = lastReply(turn);
      if (!reply || !questionsOwner(reply) || askedWithButton(thisTurn(lines, true))) return;
      if (sentBack(hook.transcript_path, JSON.stringify(turn[0] ?? null).slice(0, 300))) return;
      process.stdout.write(JSON.stringify({ decision: 'block', reason: REASON }));
    } catch {
      // never stand in a room's way over a hook problem
    }
  });
}
