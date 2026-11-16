#!/usr/bin/env node
// A global PreToolUse hook (Bash): nothing turns on the Mac's camera or microphone without the
// owner's yes for that one capture (a session photographing something on the desk with
// `ffmpeg -f avfoundation -i 0` would otherwise switch the camera on unannounced). A room asks on a
// `manager/ask --why camera` button; their Approve writes a one-time pass (target device:camera, hooks/post-approvals.mjs) that lets one
// capture command run from that room within 2 hours. Listing devices and --help are never held up,
// and text that only mentions a capture command (a commit message, a heredoc given to cat) is not one.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commands, programAt } from './screen-click-guard.mjs';
import { approvalsPath, useTargetPass } from './post-approvals.mjs';

export const TARGET = 'device:camera';
const ASK = '~/.tiny-hq/app/manager/ask';

const name = (x) => String(x).split('/').pop();
const is = (re) => (x) => re.test(name(x));
const value = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? String(args[i + 1] ?? '') : undefined;
};
const SOX_VALUE = new Set(['-t', '--type', '-r', '--rate', '-c', '--channels', '-b', '--bits', '-e', '--encoding', '-v', '--volume', '-C', '--compression', '--buffer', '--comment']);
const help = (args) => args.some((a) => a === '-h' || a === '--help' || a === '-help');

// Capture code in a script (python, swift, osascript, node...): a call that opens a device, not a
// package name, so `pip install sounddevice` or listing devices is not a capture.
export const CAPTURE_CODE = /\bVideoCapture\s*\(|AVCaptureSession\s*\(|AVCaptureDevice\s*\.\s*(?:default|devices)|AVCaptureDeviceInput\b|AVAudioRecorder\s*\(|\binputNode\b|\b(?:sd|sounddevice)\s*\.\s*(?:rec|playrec|InputStream|RawInputStream|Stream)\s*\(|pyaudio[^]*input\s*=\s*True|getUserMedia\s*\(|application\s+"(?:Photo Booth|FaceTime)"/;
const INTERPRETER = /^(python[\d.]*|swift|osascript|node|ruby|perl|bun|deno|tsx|ts-node)$/;
// Runners that start another program further along (uv run python ..., npx ffmpeg ..., xcrun swift ...).
const RUNNERS = /^(uv|uvx|npx|bunx|pnpx|pnpm|yarn|xcrun|poetry|pipx|pdm|hatch|rye|conda|mamba|micromamba|arch|pixi)$/;
// Where the program that passes `test` runs: as the command, or anywhere after a runner.
function runsAt(w, test) {
  const at = programAt(w, test);
  if (at >= 0) return at;
  const r = programAt(w, is(RUNNERS));
  if (r < 0) return -1;
  for (let i = r + 1; i < w.length; i++) if (test(w[i])) return i;
  return -1;
}
// A script file the interpreter is given (python3 snap.py): its code is read, up to 1 MB.
function scriptText(args, cwd) {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    try {
      const p = resolve(cwd ?? process.cwd(), a.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
      if (statSync(p).size > 1_000_000) return '';
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  }
  return '';
}

// What one simple command would capture: 'camera', 'microphone', 'camera or microphone', or undefined.
export function captures(w, cwd) {
  let at;
  // ffmpeg family: an avfoundation (or the old qtkit) input is the camera or the microphone.
  if ((at = runsAt(w, is(/^(ffmpeg|ffplay|ffprobe)$/))) >= 0) {
    const args = w.slice(at + 1);
    if (help(args)) return undefined;
    // An input's options come before its -i (an avfoundation output after all inputs is not a capture);
    // ffplay and ffprobe take the input without -i.
    const lastI = args.lastIndexOf('-i');
    const input = (i) => !/ffmpeg$/.test(w[at]) || i < lastI;
    const fmt = args.some((a, i) => (a === '-f' || a === '-format') && /^(avfoundation|qtkit)$/i.test(args[i + 1] ?? '') && input(i));
    if (!fmt) return undefined;
    if (/^(true|1)$/i.test(value(args, '-list_devices') ?? '')) return undefined; // only lists them
    return 'camera or microphone';
  }
  if ((at = runsAt(w, is(/^imagesnap$/))) >= 0) {
    const args = w.slice(at + 1);
    return args.some((a) => a === '-l' || a === '-h') ? undefined : 'camera';
  }
  if ((at = runsAt(w, is(/^rec$/))) >= 0) return help(w.slice(at + 1)) ? undefined : 'microphone';
  if ((at = runsAt(w, is(/^sox$/))) >= 0) {
    // sox records when its first file is the default device (-d) or a coreaudio input.
    const args = w.slice(at + 1);
    if (help(args)) return undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-d' || a === '--default-device') return 'microphone';
      if ((a === '-t' || a === '--type') && /^(coreaudio|ca)$/i.test(args[i + 1] ?? '')) return 'microphone';
      if (a === '-n' || a === '--null') return undefined;
      if (SOX_VALUE.has(a)) i++;
      else if (!a.startsWith('-')) return undefined; // the first file is a real file: it plays or converts
    }
    return undefined;
  }
  if ((at = programAt(w, is(/^gst-launch(-1\.0)?$/))) >= 0) {
    return w.slice(at + 1).some((a) => /^(avfvideosrc|osxaudiosrc|autovideosrc|autoaudiosrc)\b/.test(a)) ? 'camera or microphone' : undefined;
  }
  if ((at = programAt(w, is(/^open$/))) >= 0) {
    return w.slice(at + 1).some((a) => /^(photo ?booth|facetime)(\.app)?\/?$/i.test(name(a.replace(/\/$/, ''))) || /^com\.apple\.(photobooth|facetime)$/i.test(a)) ? 'camera' : undefined;
  }
  if ((at = runsAt(w, is(INTERPRETER))) >= 0) {
    const args = w.slice(at + 1);
    if (args.some((a) => CAPTURE_CODE.test(a)) || CAPTURE_CODE.test(scriptText(args, cwd))) return 'camera or microphone';
  }
  return undefined;
}

// What a shell command would turn on, if anything.
export function deviceUse(command, cwd) {
  if (typeof command !== 'string' || !command.trim()) return undefined;
  const all = commands(command);
  for (const words of all) {
    const what = captures(words, cwd);
    if (what) return what;
  }
  // Code fed on stdin (python3 - <<'EOF' ..., swift - <<EOF): the parser drops heredoc bodies, so an
  // interpreter in the command plus capture code anywhere in its text counts.
  if (CAPTURE_CODE.test(command) && all.some((w) => runsAt(w, is(INTERPRETER)) >= 0)) return 'camera or microphone';
  return undefined;
}

// A pass covers only the command the owner approved: the button's text must hold this exact command
// (spaces aside), so a yes for one photo can't be spent on a different capture.
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const approves = (passText, command) => !!squash(command) && squash(passText).includes(squash(command));

export function denyReason(what) {
  return `This would turn on the owner's ${what}. Nothing switches on their camera or microphone without their yes for that one capture. Put it on a button and stop: \`${ASK} "<what you want to capture and why, with the exact command>" --why camera --tried "<what you tried without it>"\`. When they approve, that exact command runs once (within 2 hours); a different capture needs its own button. Listing devices (ffmpeg -list_devices true, imagesnap -l) is fine without asking.`;
}

// undefined to let it run; a reason to refuse it. A capture with an unused pass for this room runs,
// and uses the pass up.
export function decideCamera(toolName, input, hook = {}, now = Date.now(), path = approvalsPath()) {
  if (toolName !== 'Bash') return undefined;
  const what = deviceUse(input?.command, hook.cwd);
  if (!what) return undefined;
  if (useTargetPass(hook.session_id, now, path, hook.cwd, TARGET, (p) => approves(p.text, input.command))) return undefined;
  return denyReason(what);
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
    let hook;
    try {
      hook = JSON.parse(raw || '{}');
    } catch {
      return;
    }
    let why;
    try {
      why = decideCamera(hook.tool_name, hook.tool_input, hook);
    } catch {
      // The pass file is busy or unreadable: a capture still waits for the owner; anything else runs.
      try {
        const what = deviceUse(hook.tool_input?.command, hook.cwd);
        why = what ? denyReason(what) : undefined;
      } catch {
        why = undefined;
      }
    }
    if (why) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
  });
}
