// The stay-awake switch: an on-off switch in Tiny HQ so the Mac doesn't lock while rooms work.
// On: Tiny HQ starts `caffeinate -d -i` (display and system stay awake, so the Mac never idles into
// its lock screen) and keeps its pid in ~/.tiny-hq/awake.json. Off: that caffeinate is stopped.
// It has no time limit; it stays on until the owner turns it off. If Tiny HQ restarts, or the caffeinate
// dies, Tiny HQ starts a new one while the switch is on.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Awake = { on: boolean; pid?: number; since?: number };

export const awakePath = (dataDir: string): string => join(dataDir, 'awake.json');

export function readAwake(path: string): Awake {
  try {
    const a = JSON.parse(readFileSync(path, 'utf8')) as Awake;
    return a && typeof a.on === 'boolean' ? a : { on: false };
  } catch {
    return { on: false };
  }
}

// Only ever our caffeinate: a pid may have been reused.
export function isCaffeinate(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().endsWith('caffeinate');
  } catch {
    return false;
  }
}

function start(): number | undefined {
  try {
    const p = spawn('/usr/bin/caffeinate', ['-d', '-i'], { detached: true, stdio: 'ignore' });
    p.on('error', () => undefined); // no caffeinate on this machine: the switch just stays off
    p.unref();
    return p.pid;
  } catch {
    return undefined;
  }
}

function stop(pid: number | undefined): void {
  if (isCaffeinate(pid)) {
    try {
      process.kill(pid!, 'SIGTERM');
    } catch {}
  }
}

// The switch. Returns the state as it now is.
export function setAwake(dataDir: string, on: boolean, now = Date.now()): Awake {
  const path = awakePath(dataDir);
  const was = readAwake(path);
  let next: Awake;
  if (on) {
    const pid = isCaffeinate(was.pid) ? was.pid : start();
    next = { on: true, pid, since: was.on && was.since ? was.since : now };
  } else {
    stop(was.pid);
    next = { on: false };
  }
  writeFileSync(path, JSON.stringify(next));
  return next;
}

// What the page shows: on only while a caffeinate of ours is really running.
export function awakeNow(dataDir: string): { on: boolean; since?: number } {
  const a = readAwake(awakePath(dataDir));
  return a.on && isCaffeinate(a.pid) ? { on: true, since: a.since } : { on: false };
}

// Tiny HQ's regular check: switch on but no caffeinate (office restarted, process killed) -> start one.
export function keepAwakeIfOn(dataDir: string): void {
  const a = readAwake(awakePath(dataDir));
  if (a.on && !isCaffeinate(a.pid)) setAwake(dataDir, true);
}
