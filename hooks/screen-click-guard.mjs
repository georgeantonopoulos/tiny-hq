#!/usr/bin/env node
// PreToolUse hook (Bash) for the office's rooms: a room's peekaboo click, typing, scroll or other
// input goes through `manager/screen <verb> ...`, which waits until the Mac's keyboard and mouse
// have been still for 30 s, so a click never lands under the owner's own hands while they work in
// the same app. Looking (image, see, list, permissions, --help) is never held up, and text that only
// mentions peekaboo (a quoted commit message, a heredoc body given to cat) is not a command. Only in sessions
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
const LISTING_VERBS = new Set(['app', 'window', 'menu', 'menubar', 'dock', 'dialog', 'space']);
const VALUE_FLAGS = new Set(['--log-level', '--bridge-socket']); // peekaboo's global flags that take a value

// Whether `peekaboo <verb> <args>` would touch the screen, rather than only list or show help.
export function isInput(verb, args = []) {
  if (!INPUT_VERBS.includes(verb)) return false;
  if (args.some((a) => a === '--help' || a === '-h')) return false;
  // Only verbs with their own subcommands list things; `type "list of items"` is still typing.
  return !(LISTING_VERBS.has(verb) && /^(list|list-all|help)$/.test(args[0] ?? ''));
}

// Where in a command the first word that passes `is` runs as the program: before it may come only
// FOO=bar, wrappers (time, nice -n 5, timeout 30, sudo -u x, xargs -I{}) with their options and
// option values, and shell keywords that start a command inside a loop or an if (do, then, {, !).
export function programAt(w, is) {
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (is(x)) return i;
    const skip = /^[A-Za-z_][A-Za-z0-9_]*=/.test(x) || WRAPPERS.has(x.split('/').pop()) || KEYWORDS.has(x) || /^-/.test(x) || /^\d+[smh]?$/.test(x) || (i > 0 && /^-/.test(w[i - 1]));
    if (!skip) return -1;
  }
  return -1;
}
const isShell = (x) => SHELLS.has(x.split('/').pop());
// How a shell in this command gets its script: { c: the -c text } (also -lc, -ec ...), { stdin: true }
// when it reads stdin (no script file, or -s), or undefined when there's no shell.
function shellScript(w) {
  const at = programAt(w, isShell);
  if (at < 0) return undefined;
  const rest = w.slice(at + 1);
  const opts = [];
  let k = 0;
  for (; k < rest.length && /^[-+]/.test(rest[k]) && rest[k] !== '--'; k++) {
    opts.push(rest[k]);
    if (/^[-+]o$/.test(rest[k])) k++; // set -o name
  }
  const flags = opts.filter((o) => /^-[A-Za-z]+$/.test(o)).join('');
  if (flags.includes('c')) return { c: rest[k] ?? '' };
  if (rest[k] === '--') k++;
  return { stdin: flags.includes('s') || k >= rest.length };
}
const runsStdin = (w) => !!shellScript(w)?.stdin;

// Split a shell command into simple commands (lists of words). Quotes make one word; comments and
// heredoc bodies are dropped (except a body a shell runs as its script); $(...), `...`, and `bash -c "..."`/eval are read as commands too.
export function commands(src, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  let words = [];
  let cur = '';
  let inWord = false;
  const heredocs = [];
  const fed = []; // heredoc bodies and here-strings: { owner, text }, read once the command is parsed
  const pipeTo = new Map(); // a command -> the next one in its pipeline
  let hereString = false;
  const endWord = () => {
    if (inWord && hereString) fed.push({ owner: words, text: cur });
    else if (inWord) words.push(cur);
    if (inWord) hereString = false;
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
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      endWord();
      hereString = true;
      i += 2;
    } else if (c === '<' && src[i + 1] === '<') {
      endWord();
      i += 2;
      const strip = src[i] === '-';
      if (strip) i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const m = /^(?:(['"])([^'"\n]+)\1|\\?([^\s;&|<>()'"]+))/.exec(src.slice(i));
      if (m) {
        heredocs.push({ tag: m[2] ?? m[3], strip, owner: words });
        i += m[0].length - 1;
      } else i--;
    } else if (c === '\n') {
      endCmd();
      for (const h of heredocs.splice(0)) {
        // skip the body, up to and including the line that is just the tag; it is only data,
        // unless a shell reads it as its script (`bash <<'EOF'`)
        let at = i + 1;
        const body = [];
        for (;;) {
          const nl = src.indexOf('\n', at);
          const line = src.slice(at, nl < 0 ? src.length : nl);
          at = nl < 0 ? src.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.tag || nl < 0) break;
          body.push(line);
        }
        i = at - 1;
        fed.push({ owner: h.owner, text: body.join('\n') });
      }
    } else if (c === '|' && src[i + 1] !== '|') {
      const from = words;
      endCmd();
      pipeTo.set(from, words);
      if (src[i + 1] === '&') i++;
    } else if (c === '|') {
      endCmd();
      i++;
    } else if (';&()'.includes(c)) {
      endCmd();
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else {
      cur += c;
      inWord = true;
    }
  }
  endCmd();
  // Text fed to a command is only data, unless a shell reads it as its script: `bash <<'EOF'`,
  // `sh <<< "..."`, or further down the pipeline (`cat <<'EOF' | bash`).
  for (const f of fed) {
    for (let w = f.owner; w; w = pipeTo.get(w)) {
      if (runsStdin(w)) {
        sub(f.text);
        break;
      }
    }
  }
  for (const w of [...out]) {
    const script = shellScript(w);
    if (script && 'c' in script) sub(script.c);
    const ev = programAt(w, (x) => x === 'eval');
    if (ev >= 0) sub(w.slice(ev + 1).join(' '));
  }
  return out;
}

// The peekaboo input verb a shell command runs directly, if any.
export function directInput(command) {
  if (typeof command !== 'string' || !command.includes('peekaboo')) return undefined;
  for (const words of commands(command)) {
    let i = programAt(words, (x) => /(^|\/)peekaboo$/.test(x));
    if (i < 0) continue;
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
