// The screen helper (Peekaboo's daemon, login agent com.tiny-hq.screen) holds the Mac's Screen
// Recording and Accessibility permissions, so room sessions can screenshot and click apps. It runs
// only while a room is testing: a room turns it on with `manager/screen on`, off with
// `manager/screen off`, and the office turns it off once its time is up (30 minutes by default), or
// if it is running without anyone having turned it on. When it is off, `peekaboo` runs in the room's
// own process, which has no permission, so it fails safely.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCREEN_LABEL } from '../daemon/launchd.ts';

export const DEFAULT_MINUTES = 30;
export const MAX_MINUTES = 120;

export type ScreenOn = { until: number; by: string; at: number; awake?: number }; // awake: pid of the caffeinate keeping the display on

export const markerPath = (dataDir: string): string => join(dataDir, 'screen-on.json');

export function readMarker(path: string): ScreenOn | undefined {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<ScreenOn>;
    if (typeof o.until === 'number' && typeof o.at === 'number' && typeof o.by === 'string') return { until: o.until, by: o.by, at: o.at, ...(typeof o.awake === 'number' ? { awake: o.awake } : {}) };
  } catch {
    // none, or unreadable
  }
  return undefined;
}

export const minutesOf = (minutes: number): number => Math.min(Math.max(Math.round(minutes) || DEFAULT_MINUTES, 1), MAX_MINUTES);

export function writeMarker(path: string, by: string, minutes: number, now = Date.now(), awake?: number): ScreenOn {
  const on: ScreenOn = { until: now + minutesOf(minutes) * 60_000, by: by.slice(0, 80), at: now, ...(awake ? { awake } : {}) };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(on) + '\n', { mode: 0o600 });
  return on;
}

export function clearMarker(path: string): void {
  rmSync(path, { force: true });
}

// Should the office stop the helper now? Running with no marker (left on, or started by hand) or past its time.
export function shouldStop(running: boolean, marker: ScreenOn | undefined, now = Date.now()): boolean {
  return running && (!marker || now >= marker.until);
}

const target = () => `gui/${process.getuid?.() ?? 501}/${SCREEN_LABEL}`;

// Set up at all (`tiny-hq screen setup`): launchd knows the agent.
export function helperInstalled(): boolean {
  try {
    execFileSync('launchctl', ['print', target()], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function helperRunning(): boolean {
  try {
    return /\bpid = \d+/.test(execFileSync('launchctl', ['print', target()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return false;
  }
}

export function startHelper(): void {
  execFileSync('launchctl', ['kickstart', target()], { stdio: 'ignore' });
}

export function stopHelper(): void {
  try {
    execFileSync('launchctl', ['kill', 'TERM', target()], { stdio: 'ignore' });
  } catch {
    // not running
  }
}

// A Mac whose display goes off locks itself, and a locked Mac can't be captured (every capture fails
// with "audio/video capture failure"). While the helper is on, caffeinate keeps the display awake for
// the same time. It runs on its own: wrapping the helper's program in it would tie the macOS
// permissions to caffeinate instead.
export function keepAwake(minutes: number): number | undefined {
  try {
    const p = spawn('/usr/bin/caffeinate', ['-d', '-i', '-t', String(minutesOf(minutes) * 60)], { detached: true, stdio: 'ignore' });
    p.unref();
    return p.pid;
  } catch {
    return undefined;
  }
}

export function letSleep(pid: number | undefined): void {
  if (!pid) return;
  try {
    // Only ever our caffeinate: a pid may have been reused.
    if (execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().endsWith('caffeinate')) process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

// A locked Mac can't be captured; only the owner can unlock it.
export function macLocked(): boolean {
  try {
    return /<key>IOConsoleLocked<\/key>\s*<true\/>/.test(execFileSync('ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return false;
  }
}

// The office's regular check: true when it stopped the helper.
export function tidyScreen(dataDir: string, now = Date.now()): boolean {
  const path = markerPath(dataDir);
  const marker = readMarker(path);
  const running = helperRunning();
  if (!shouldStop(running, marker, now)) {
    if (!running && marker) {
      letSleep(marker.awake);
      clearMarker(path);
    }
    return false;
  }
  stopHelper();
  letSleep(marker?.awake);
  clearMarker(path);
  return true;
}

// A room's click, typing or scroll waits until the Mac's keyboard and mouse have been still for
// 30 s, so it never lands under the owner's own hands while they work in the same app. Rooms go
// through `manager/screen click|type|...`; hooks/screen-click-guard.mjs refuses peekaboo's input
// commands run directly in a room.
export const STILL_MS = 30_000;
export const lastInputPath = (dataDir: string): string => join(dataDir, 'screen-last-input');

// Milliseconds since the last keyboard or mouse event, or undefined if macOS won't say.
export function idleMs(): number | undefined {
  try {
    const m = /"HIDIdleTime" = (\d+)/.exec(execFileSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 }));
    return m ? Math.floor(Number(m[1]) / 1e6) : undefined;
  } catch {
    return undefined;
  }
}

// Still enough to click? 30 s of nothing, or the last event was the office's own input (a room's
// previous click, which itself only ran after 30 s of stillness), so the owner hasn't touched it since.
export function stillEnough(idle: number, now: number, lastOwn?: number): boolean {
  if (idle >= STILL_MS) return true;
  return lastOwn !== undefined && lastOwn <= now && now - idle <= lastOwn + 2_000;
}

export function readLastInput(path: string): number | undefined {
  try {
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastInput(path: string, at = Date.now()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${at}\n`, { mode: 0o600 });
}
