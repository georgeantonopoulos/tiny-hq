#!/usr/bin/env node
// Stop hook for the manager's session (manager/.claude/settings.json): a question to the owner is a
// button, never a line in chat. If the manager ends a turn with a question to the owner in their reply
// and didn't run manager/ask (or job wait) this turn, they are sent back once to put it on a
// button and take it out of the reply. Never blocks if anything can't be read.
//
// The manager should be the example: a reply ending "Shall I ask Rosa…?" makes the owner answer in chat.
//
// Once per turn, kept by its own note rather than stop_hook_active: the manager's whiteboard hook
// may have sent them back already this turn, and the reply after that is the one the owner reads.

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TAIL = 4 * 1024 * 1024;

// Lines the office or Claude Code put into the manager's chat in the middle of a turn: they don't start one.
const INJECTED = /^\s*(\[Office[: ]|\[Scheduled: |<task-notification|<cross-session-message|<system-reminder|<pasted_content)/;

// Everything after the last message typed into the manager's chat. With `pastOffice`, office and
// system lines don't count as a start: it goes back to the last message of the owner's (so a
// button put up before an office ping arrived mid-turn still counts).
export function thisTurn(lines, pastOffice = false) {
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (d.isSidechain) continue;
    if (d.type === 'user' && !d.isMeta && d.message) {
      const c = d.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('') : '';
      if (text && !(pastOffice && INJECTED.test(text))) return out;
    }
    out.unshift(d);
  }
  return out;
}

// Did the turn put a question on a button?
export function askedWithButton(turn) {
  return turn.some(
    (d) =>
      d.type === 'assistant' &&
      Array.isArray(d.message?.content) &&
      d.message.content.some((x) => x?.type === 'tool_use' && x.name === 'Bash' && /manager\/ask\b|manager\/job\s+wait\b/.test(String(x.input?.command ?? ''))),
  );
}

// The reply the owner reads: the last text the manager wrote this turn. "(quiet)" is never shown as a
// bubble, so after a "(quiet)" (say, once the whiteboard check sent them back) the bubble
// still holds the reply before it.
export function lastReply(turn) {
  for (let i = turn.length - 1; i >= 0; i--) {
    const c = turn[i].type === 'assistant' ? turn[i].message?.content : undefined;
    if (!Array.isArray(c)) continue;
    const text = c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n').trim();
    if (text && text !== '(quiet)') return text;
  }
  return '';
}

// A question put to the owner: a sentence ending in "?" that asks them something ("Shall I…?",
// "Want me to…?", "OK to…?"), or any question the reply ends on ("Sound good?").
// An aside to camera in italics with no "you" in it doesn't count, nor code.
const ASKS_HIM = /\b(you|your|shall i|should i|shall we|should we|want me|can i|may i|ok to|okay to|good to go|owner|boss)\b/i;
export function questionsOwner(reply) {
  const plain = reply
    .replace(/`[^`]*`/g, '')
    .replace(/(?<![*\w])\*(?!\*)([^*\n]+)\*(?![*\w])/g, (m, inner) => (ASKS_HIM.test(inner) ? inner : '')) // *aside*
    .replace(/\*\*/g, '');
  const sentences = plain.match(/[^.!?\n]*[.!?]+/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const tail = plain.trim();
  if (tail.endsWith('?')) return true;
  return sentences.some((s) => s.endsWith('?') && ASKS_HIM.test(s));
}

function readTail(path) {
  const fd = openSync(path, 'r');
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

// Once per turn: the turn's first entry, remembered per transcript.
const NOTE = join(process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq'), 'manager', 'ask-guard.json');
function alreadySentBack(transcript, turnKey) {
  try {
    return JSON.parse(readFileSync(NOTE, 'utf8'))[transcript] === turnKey;
  } catch {
    return false;
  }
}
function rememberSentBack(transcript, turnKey) {
  try {
    mkdirSync(dirname(NOTE), { recursive: true, mode: 0o700 });
    writeFileSync(NOTE, JSON.stringify({ [transcript]: turnKey }), { mode: 0o600 });
  } catch {
    /* best effort: at worst they're asked once more */
  }
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
      if (!hook.transcript_path) return;
      const lines = readTail(hook.transcript_path);
      const turn = thisTurn(lines);
      const reply = lastReply(turn);
      if (!reply || !questionsOwner(reply) || askedWithButton(thisTurn(lines, true))) return;
      // The turn's key: its first entry (the same however many times they're sent back).
      const key = JSON.stringify(turn[0] ?? null).slice(0, 300);
      if (alreadySentBack(hook.transcript_path, key)) return;
      rememberSentBack(hook.transcript_path, key);
      process.stdout.write(
        JSON.stringify({
          decision: 'block',
          reason:
            'Question check (the office): your reply asks the owner a question in chat. A question to them is a button: run ~/.tiny-hq/app/manager/ask "<the question>" --why <send|post|pay|choice|permission|password> --tried "<what you tried>" (add --choices "<a>" "<b>" for options), then reply again without the question. If it was only rhetorical, say it as a statement.',
        }),
      );
    } catch {
      // never stand in the manager's way over a hook problem
    }
  });
}
