#!/usr/bin/env node
// Stop hook for every room of the office (global, in ~/.claude/settings.json) and for the manager
// (manager/.claude/settings.json, run with --manager): a question to the owner is a button, never a
// line in chat. A question asked only in a chat shows no question mark over anyone's head, so the
// owner may never see it. If a session ends a turn asking the owner something and didn't put up a
// button (manager/ask or job wait) this turn, it is sent back once to do that. One check for
// everyone; the manager gets its own wording.
//
// Only for a session whose project has an office name tag (<data>/tags/), worktrees included, or
// the manager's folder. The manager's own settings run it with --manager, so the manager is covered
// even when the optional global hook isn't installed; the global run leaves the manager's folder to
// that one, so it never runs twice. Sent back once per turn, kept by its own note rather than
// stop_hook_active: another hook may have sent the session back already this turn, and the reply
// after that is the one the owner reads. Never blocks if anything can't be read.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DATA = process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq');
const MANAGER = join(dirname(fileURLToPath(import.meta.url)), '..', 'manager');
const TAIL = 4 * 1024 * 1024;

// Lines the office or Claude Code put into a chat in the middle of a turn: they don't start one.
const INJECTED = /^\s*(\[Office[: ]|\[Scheduled: |<task-notification|<cross-session-message|<system-reminder|<pasted_content)/;

// Everything after the last message typed into the chat. With `pastOffice`, office and
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

// Did the turn put a question on a button? Only a manager/ask or job wait that went up counts: one the
// office refused ("No button for the owner"), a --help, list or cancel, a call that errored, or the
// words "manager/ask" quoted inside another command's text is not a button. Otherwise a refused
// button would let the same question through in chat.
const ASK_CALL = /manager\/ask\b|manager\/job\s+wait\b/;
const NOT_A_BUTTON = /manager\/ask\s+(list|cancel|--help|-h)\b|manager\/(ask|job\s+wait)\b[^|;&]*\s--help\b/;
const REFUSED = /No button for the owner|Not waiting on the owner/;
const resultText = (r) =>
  typeof r?.content === 'string' ? r.content : Array.isArray(r?.content) ? r.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('') : '';
const unquoted = (cmd) => cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
export function askedWithButton(turn) {
  const results = new Map();
  for (const d of turn)
    if (Array.isArray(d.message?.content))
      for (const x of d.message.content) if (x?.type === 'tool_result' && x.tool_use_id) results.set(x.tool_use_id, x);
  return turn.some(
    (d) =>
      d.type === 'assistant' &&
      Array.isArray(d.message?.content) &&
      d.message.content.some((x) => {
        if (x?.type !== 'tool_use' || x.name !== 'Bash') return false;
        const cmd = unquoted(String(x.input?.command ?? '')); // "manager/ask" written inside a note's text is not a call
        if (!ASK_CALL.test(cmd) || NOT_A_BUTTON.test(cmd)) return false;
        const r = results.get(x.id);
        if (!r) return true; // no result to read: give it the benefit of the doubt
        return !r.is_error && !REFUSED.test(resultText(r));
      }),
  );
}

// The reply the owner reads: the last text written this turn. "(quiet)" is never shown as a
// bubble, so after a "(quiet)" the bubble
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

// The reply this turn ends on. Claude Code hands it to the hook as last_assistant_message; the
// chat file often doesn't hold it yet when the hook runs (most room questions slipped through
// when the hook read the file first), so the file is only the fallback.
export function replyOf(hook, turn) {
  const given = typeof hook?.last_assistant_message === 'string' ? hook.last_assistant_message.trim() : '';
  return given && given !== '(quiet)' ? given : lastReply(turn);
}

// A question put to the owner: the reply ends on one ("Shall I…?", "Sound good?"), or ends on a
// line that leaves something waiting on them with no question mark ("The only thing left on #16 is
// your merge"). Only the last sentence counts: a report that asked something earlier and then
// answered it is not sent back. An aside to camera in italics with no "you" in it doesn't count,
// nor code.
const ASKS_HIM = /\b(you|your|shall i|should i|shall we|should we|want me|can i|may i|ok to|okay to|good to go|owner|boss)\b/i;
const WAITS_ON_THEM =
  /\b(?:waiting (?:on|for) (?:you|your|the owner)|waits (?:on|for) (?:you|your|the owner)|(?:over|up) to you\b|(?:needs|need|awaiting|pending) (?:your|the owner'?s) (?:merge|call|go-?ahead|approval|yes|ok|okay|decision|sign-?off|click|review|answer|pick)|(?:only thing|all that'?s|what'?s) left[^.!?\n]*\b(?:you|your|the owner'?s)\b|your (?:merge|go-?ahead|approval|sign-?off) (?:is|puts|will|would))/i;
const NOT_WAITING = /\b(nothing|no one|nobody|not|no longer|never|none)\b|n't\b/i; // "Nothing is waiting on you"
// Lines after a question that don't answer it: list items, table rows, rules, sign-offs ("— Sam").
const TRAILER = /^(?:[-*+•]\s|\d+[.)]\s|[a-z][.)]\s|\||[-=_*]{3,}$|[—–-]{1,2}\s*\S{1,40}$|>)/i;
// What may close a question: brackets, quotes, emphasis, emoji, spaces.
const CLOSERS = /[\s)\]}"'’”*_~\p{Extended_Pictographic}\uFE0F\u200D]+$/u;
export function questionsOwner(reply) {
  const plain = reply
    .replace(/```[\s\S]*?(?:```|$)/g, '') // code blocks, closed or not
    .replace(/`[^`]*`/g, '')
    .replace(/(?<![*\w])\*(?!\*)([^*\n]+)\*(?![*\w])/g, (m, inner) => (ASKS_HIM.test(inner) ? inner : '')) // *aside*
    .replace(/\*\*/g, '');
  // What follows the question doesn't hide it: options listed under it, a table, a sign-off.
  const lines = plain.split('\n').map((s) => s.trim()).filter(Boolean);
  while (lines.length > 1 && TRAILER.test(lines[lines.length - 1])) lines.pop();
  // A sentence ends at a stop followed by a space ("example.com" is one word).
  const last = (lines.pop() ?? '').replace(CLOSERS, '').split(/(?<=[.!?])\s+/).pop() ?? '';
  if (/\?[!?]*$/.test(last.replace(CLOSERS, ''))) return true;
  return WAITS_ON_THEM.test(last) && !NOT_WAITING.test(last);
}

// The last 4 MB of the chat: a long-running chat (the manager's especially) can run to hundreds of MB.
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

// The room's project folder for a session folder: a worktree counts as its project.
export const roomFolder = (dir) => dir.replace(/\/\.claude\/worktrees\/.*$/, '');
// The name tag's file, named the way Claude Code names project folders (as office-name.sh does).
export const tagFile = (dir, data = DATA) => join(data, 'tags', `${roomFolder(dir).replace(/[^a-zA-Z0-9]/g, '-')}.md`);
export function isManager(dir, manager = MANAGER) {
  if (!dir) return false;
  const root = roomFolder(dir).replace(/\/$/, '');
  return root === manager || root.endsWith('/.tiny-hq/app/manager');
}
// A room: a tagged project folder, never the manager's (the manager's own settings check it).
export function isRoom(dir, data = DATA, manager = MANAGER) {
  if (!dir || isManager(dir, manager)) return false;
  return existsSync(tagFile(dir, data));
}

export const REASON =
  'Question check (the office): your reply asks the owner a question in chat (or leaves something waiting on them), so no question mark shows over your head and they may never see it. A question to them is a button: run ~/.tiny-hq/app/manager/ask "<the question>" --why <post|pay|irreversible|choice|permission|hands|camera|password> --tried "<what you tried>" (for a choice, add --choices "<your pick>" "<other>"), and take down any older button of yours it replaces (manager/ask list, manager/ask cancel <id>). Then reply again, saying the question is on the button. If it is a small, reversible choice that does not change what the owner gets, decide it, say what you decided as a statement, and add it to their evening note: ~/.tiny-hq/app/manager/evening add "<what you decided, and why>". If it was only rhetorical, say it as a statement.';
// The manager's version: no evening-note escape hatch, the owner's question goes on a button.
export const MANAGER_REASON =
  'Question check (the office): your reply asks the owner a question in chat (or leaves something waiting on them). A question to them is a button: run ~/.tiny-hq/app/manager/ask "<the question>" --why <post|pay|irreversible|choice|permission|hands|camera|password> --tried "<what you tried>" (add --choices "<a>" "<b>" for options), then reply again without the question. If it was only rhetorical, say it as a statement.';

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
      const manager = process.argv.includes('--manager');
      if (!hook.transcript_path || !(manager ? isManager(dir) : isRoom(dir))) return;
      const lines = readTail(hook.transcript_path);
      const turn = thisTurn(lines);
      const reply = replyOf(hook, turn);
      const key = JSON.stringify(turn[0] ?? null).slice(0, 300);
      if (reply && questionsOwner(reply) && !askedWithButton(thisTurn(lines, true)) && !sentBack(hook.transcript_path, key)) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: manager ? MANAGER_REASON : REASON }));
      }
    } catch {
      // never stand in anyone's way over a hook problem
    }
  });
}
