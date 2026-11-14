#!/usr/bin/env node
// PreToolUse hook (Bash) for the office's rooms: a room's peekaboo click, typing, scroll or other
// input goes through `manager/screen <verb> ...`, which waits until the Mac's keyboard and mouse
// have been still for 30 s, so a click never lands under the owner's own hands while they work in
// the same app. Looking (image, see, list, permissions, --help) is never held up, and text that only
// mentions peekaboo (a quoted commit message, a heredoc body) is not a command. Only in sessions
// whose project has an office name tag; never blocks if anything can't be read.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isRoom } from './room-ask-guard.mjs';

const SCREEN = '~/.tiny-hq/app/manager/screen';

// peekaboo's commands that act on the screen (`peekaboo --help`: Interaction, System, AI, run).
export const INPUT_VERBS = ['click', 'type', 'press', 'hotkey', 'scroll', 'move', 'drag', 'swipe', 'paste', 'menu', 'menubar', 'app', 'window', 'dock', 'dialog', 'open', 'space', 'agent', 'run'];
const WRAPPERS = new Set(['exec', 'command', 'env', 'sudo', 'timeout', 'time', 'nice', 'nohup', 'xargs', 'caffeinate', 'stdbuf', 'polter']);
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'while', 'until', 'if', '{', '!']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const VALUE_FLAGS = new Set(['--log-level', '--bridge-socket']); // peekaboo's global flags that take a value

// Whether `peekaboo <verb> <args>` would touch the screen, rather than only list or show help.
export function isInput(verb, args = []) {
  if (!INPUT_VERBS.includes(verb)) return false;
  if (args.some((a) => a === '--help' || a === '-h')) return false;
  return !/^(list|help)/.test(args[0] ?? '');
}

// Split a shell command into simple commands (lists of words). Quotes make one word; heredoc
// bodies and comments are dropped; $(...), `...`, and `bash -c "..."`/eval are read as commands too.
export function commands(src, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let words = [];
  let cur = '';
  let inWord = false;
  const heredocs = [];
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  const sub = (body) => out.push(...commands(body, depth + 1));
  const closeParen = (from) => {
    let d = 1;
    for (let j = from; j < src.length; j++) {
      const ch = src[j];
      if (ch === '\\') j++;
      else if (ch === "'") j = src.indexOf("'", j + 1) < 0 ? src.length : src.indexOf("'", j + 1);
      else if (ch === '(') d++;
      else if (ch === ')' && --d === 0) return j;
    }
    return src.length;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] !== '\n') cur += src[i + 1] ?? '';
      inWord = true;
      i++;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const e = j < 0 ? src.length : j;
      cur += src.slice(i + 1, e);
      inWord = true;
      i = e;
    } else if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') cur += src[++j] ?? '';
        else if (src[j] === '$' && src[j + 1] === '(') {
          const e = closeParen(j + 2);
          sub(src.slice(j + 2, e));
          j = e;
        } else if (src[j] === '`') {
          const e = src.indexOf('`', j + 1) < 0 ? src.length : src.indexOf('`', j + 1);
          sub(src.slice(j + 1, e));
          j = e;
        } else cur += src[j];
      }
      i = j;
    } else if (c === '$' && src[i + 1] === '(') {
      const e = closeParen(i + 2);
      sub(src.slice(i + 2, e));
      inWord = true;
      i = e;
    } else if (c === '`') {
      const e = src.indexOf('`', i + 1) < 0 ? src.length : src.indexOf('`', i + 1);
      sub(src.slice(i + 1, e));
      inWord = true;
      i = e;
    } else if (c === '#' && !inWord) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      i += 2;
      const strip = src[i] === '-';
      if (strip) i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(i));
      if (m) {
        heredocs.push({ tag: m[2], strip });
        i += m[0].length - 1;
      } else i--;
    } else if (c === '\n') {
      endCmd();
      for (const h of heredocs.splice(0)) {
        // drop the body, up to and including the line that is just the tag
        let at = i + 1;
        for (;;) {
          const nl = src.indexOf('\n', at);
          const line = src.slice(at, nl < 0 ? src.length : nl);
          at = nl < 0 ? src.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.tag || nl < 0) break;
        }
        i = at - 1;
      }
    } else if (';&|()'.includes(c)) {
      endCmd();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      cur += c;
      inWord = true;
    }
  }
  endCmd();
  for (const w of [...out]) {
    const prog = w.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) && !WRAPPERS.has(x)) ?? '';
    const base = prog.split('/').pop();
    if (SHELLS.has(base)) {
      const at = w.indexOf('-c');
      if (at >= 0 && w[at + 1] !== undefined) sub(w[at + 1]);
    } else if (base === 'eval') sub(w.slice(w.indexOf(prog) + 1).join(' '));
  }
  return out;
}

// The peekaboo input verb a shell command runs directly, if any.
export function directInput(command) {
  if (typeof command !== 'string' || !command.includes('peekaboo')) return undefined;
  for (const words of commands(command)) {
    let i = 0;
    // FOO=bar, wrappers (time, nice -n 5, timeout 30, xargs -I{}) and their options
    // and shell keywords that start a command inside a loop or an if (do, then, {, !)
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i].split('/').pop()) || KEYWORDS.has(words[i]) || /^-/.test(words[i]) || /^\d+[smh]?$/.test(words[i]))) i++;
    if (!/(^|\/)peekaboo$/.test(words[i] ?? '')) continue;
    i++;
    while (i < words.length && words[i].startsWith('-')) i += VALUE_FLAGS.has(words[i]) ? 2 : 1;
    const verb = words[i];
    if (isInput(verb, words.slice(i + 1))) return verb;
  }
  return undefined;
}

export function decideScreen(toolName, input) {
  if (toolName !== 'Bash') return undefined;
  const verb = directInput(input?.command);
  if (!verb) return undefined;
  return `Clicks and typing on the owner's Mac go through the screen helper, which waits until they have left the keyboard and mouse alone for 30 s, so nothing lands under their hands. Run the same command with \`${SCREEN}\` in place of \`peekaboo\`, e.g. \`${SCREEN} ${verb} ...\`. Screenshots (peekaboo image, see, list) are unchanged.`;
}

let isMain = false;
try {
  isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      const hook = JSON.parse(raw || '{}');
      const why = decideScreen(hook.tool_name, hook.tool_input);
      if (why && isRoom(process.env.CLAUDE_PROJECT_DIR || hook.cwd || '')) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
    } catch {
      // never block on a guard problem: this one protects the owner's attention, not a secret
    }
  });
}
