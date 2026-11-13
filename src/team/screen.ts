// The screen helper (Peekaboo's daemon, login agent com.tiny-hq.screen) holds the Mac's Screen
// Recording and Accessibility permissions, so room sessions can screenshot and click apps. It runs
// only while a room is testing: a room turns it on with `manager/screen on`, off with
// `manager/screen off`, and the office turns it off once its time is up (30 minutes by default), or
// if it is running without anyone having turned it on. When it is off, `peekaboo` runs in the room's
// own process, which has no permission, so it fails safely.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCREEN_LABEL } from '../daemon/launchd.ts';

export const DEFAULT_MINUTES = 30;
export const MAX_MINUTES = 120;

export type ScreenOn = { until: number; by: string; at: number };

export const markerPath = (dataDir: string): string => join(dataDir, 'screen-on.json');

export function readMarker(path: string): ScreenOn | undefined {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<ScreenOn>;
    if (typeof o.until === 'number' && typeof o.at === 'number' && typeof o.by === 'string') return { until: o.until, by: o.by, at: o.at };
  } catch {
    // none, or unreadable
  }
  return undefined;
}

export function writeMarker(path: string, by: string, minutes: number, now = Date.now()): ScreenOn {
  const m = Math.min(Math.max(Math.round(minutes) || DEFAULT_MINUTES, 1), MAX_MINUTES);
  const on = { until: now + m * 60_000, by: by.slice(0, 80), at: now };
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

// The office's regular check: true when it stopped the helper.
export function tidyScreen(dataDir: string, now = Date.now()): boolean {
  const path = markerPath(dataDir);
  const marker = readMarker(path);
  const running = helperRunning();
  if (!shouldStop(running, marker, now)) {
    if (!running && marker) clearMarker(path);
    return false;
  }
  stopHelper();
  clearMarker(path);
  return true;
}
