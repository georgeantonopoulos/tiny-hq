#!/usr/bin/env node
// PreToolUse hook (Bash) for the office's rooms: a room's peekaboo click, typing, scroll or other
// input goes through `manager/screen <verb> ...`, which waits until the Mac's keyboard and mouse
// have been still for 30 s, so a click never lands under the owner's own hands while they work in
// the same app. Looking (image, see, list, permissions) is never held up. Only in sessions whose
// project has an office name tag; never blocks if anything can't be read.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isRoom } from './room-ask-guard.mjs';

export const INPUT_VERBS = ['click', 'type', 'press', 'hotkey', 'scroll', 'move', 'drag', 'swipe', 'paste', 'menu', 'app', 'window', 'dock', 'dialog'];
const READ_ONLY_SUB = new Set(['list', '--help', '-h', 'help']);
const SCREEN = '~/.tiny-hq/app/manager/screen';
const SKIP_WORDS = new Set(['exec', 'command', 'env', 'sudo', 'timeout', 'nohup', 'time', 'xargs', 'do', 'then', 'else', '{', '!']);

// The peekaboo input verb a shell command runs directly, if any.
export function directInput(command) {
  if (typeof command !== 'string' || !command.includes('peekaboo')) return undefined;
  for (const part of command.split(/[\n;&|()`]|\$\(/)) {
    const words = part.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)); // FOO=bar peekaboo ...
    // Shell keywords and wrappers in front (a loop's `do`, `nohup`, `bash -c "..."`), and a quote opening the -c string.
    for (;;) {
      if (SKIP_WORDS.has(words[0] ?? '') || /^\d+$/.test(words[0] ?? '')) words.shift();
      else if (/^(?:\S*\/)?(?:ba|z)?sh$/.test(words[0] ?? '') && words[1] === '-c') words.splice(0, 2);
      else break;
    }
    if (!/(^|\/)peekaboo$/.test((words[0] ?? '').replace(/^['"]|['"]$/g, ''))) continue;
    const verb = words[1];
    if (!INPUT_VERBS.includes(verb)) continue;
    if (['menu', 'app', 'window', 'dock', 'dialog'].includes(verb) && READ_ONLY_SUB.has(words[2] ?? '')) continue;
    return verb;
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
