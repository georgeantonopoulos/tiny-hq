// Runaway programs. A simulator a room boots and forgets can keep a web page at a full CPU core
// for days after the room went quiet, and the Mac runs hot. A plain check on the office tick,
// no tokens:
//
//   - A booted iOS/watchOS/tvOS simulator is shut down SIM_MAX_MS after the office first saw it
//     booted, unless the owner is using it right now (Simulator or Xcode in front and the Mac
//     touched in the last few minutes). A room that still needs it boots it again
//     (`xcrun simctl boot`).
//   - Any other program averaging HOG_SHARE of a core or more over the last HOG_WINDOW_MS is
//     reported once (the manager puts it to the owner on a button). The office never kills those
//     itself: it may be the owner's own render or a build they want.
//
// macOS's own processes (/System, /usr/libexec, /usr/sbin, /sbin, /Library/Apple) are left out: they are the OS.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIM_MAX_MS = 3 * 60 * 60_000;
export const OWNER_USING_MS = 5 * 60_000;
export const HOG_SHARE = 0.8;
export const HOG_WINDOW_MS = 60 * 60_000;
export const EVERY_MS = 5 * 60_000;

export interface Proc { pid: number; cpuSec: number; ageSec: number; command: string }
export interface Sample { at: number; cpuSec: number }
export interface RunawayState {
  sims: Record<string, number>; // booted simulator udid -> when the office first saw it booted
  told: number[]; // pids already reported
}

export const statePath = (dataDir: string) => join(dataDir, 'runaway.json');

export function loadState(dataDir: string): RunawayState {
  try {
    const s = JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as Partial<RunawayState>;
    return { sims: s.sims ?? {}, told: s.told ?? [] };
  } catch {
    return { sims: {}, told: [] };
  }
}

export function saveState(dataDir: string, s: RunawayState): void {
  const p = statePath(dataDir);
  writeFileSync(p + '.tmp', JSON.stringify(s));
  renameSync(p + '.tmp', p);
}

// ps cputime is "M:SS.ss" or "MMM:SS.ss" (minutes can pass 60), sometimes "H:MM:SS"; etime is "[[DD-]HH:]MM:SS".
export function seconds(t: string): number {
  const [days, rest] = t.includes('-') ? t.split('-') : ['0', t];
  const parts = rest!.split(':').map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return Number(days) * 86_400 + s;
}

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), cpuSec: seconds(m[2]!), ageSec: seconds(m[3]!), command: m[4]!.trim() });
  }
  return procs;
}

// macOS's own programs: its folders, and kernel processes ps shows in brackets. Bare names (node,
// npm, python3, claude) are what rooms start, so they count.
const SYSTEM = /^(\/(System|usr\/libexec|usr\/sbin|sbin|Library\/Apple)\/|\()/;
export const isSystem = (command: string) => SYSTEM.test(command);
export const isSimulator = (command: string) => command.includes('/CoreSimulator/') || command.includes('SimulatorRuntime');

// A program's name as the owner would say it: the app bundle, else the file name.
export function nameOf(command: string): string {
  const apps = [...command.matchAll(/([^/]+)\.app(?:x)?\//g)].map((m) => m[1]!);
  if (apps.length) return apps[0] === apps[apps.length - 1] ? apps[0]! : `${apps[0]} (${apps[apps.length - 1]})`;
  return command.split(' ')[0]!.split('/').pop()!;
}

// Programs that averaged at least HOG_SHARE of a core over a full window, not yet reported.
// `samples` keeps each pid's oldest sample still inside the window plus the newest, so the average
// covers a whole window; a pid that went away is forgotten.
export function findHogs(procs: Proc[], samples: Map<number, Sample[]>, told: Set<number>, now: number): { proc: Proc; share: number }[] {
  const hogs: { proc: Proc; share: number }[] = [];
  const alive = new Set<number>();
  for (const p of procs) {
    if (isSystem(p.command) || isSimulator(p.command)) continue;
    alive.add(p.pid);
    const list = samples.get(p.pid) ?? [];
    if (list.length && list[list.length - 1]!.cpuSec > p.cpuSec) list.length = 0; // pid reused
    list.push({ at: now, cpuSec: p.cpuSec });
    while (list.length > 2 && now - list[1]!.at >= HOG_WINDOW_MS) list.shift();
    samples.set(p.pid, list);
    const first = list[0]!;
    const span = (now - first.at) / 1000;
    if (span * 1000 < HOG_WINDOW_MS || told.has(p.pid)) continue;
    const share = (p.cpuSec - first.cpuSec) / span;
    if (share >= HOG_SHARE) hogs.push({ proc: p, share });
  }
  for (const pid of samples.keys()) if (!alive.has(pid)) samples.delete(pid);
  return hogs;
}

// Simulators to shut down now; `sims` is updated in place (new ones noted, gone ones dropped). While
// the owner is at Simulator or Xcode the clock starts again, so their own long session is never cut off.
export function simsToStop(booted: string[], sims: Record<string, number>, ownerUsing: boolean, now: number): string[] {
  for (const id of Object.keys(sims)) if (!booted.includes(id)) delete sims[id];
  for (const id of booted) sims[id] = ownerUsing ? now : (sims[id] ?? now);
  if (ownerUsing) return [];
  return booted.filter((id) => now - sims[id]! >= SIM_MAX_MS);
}

// --- the Mac side (async, so a slow simctl never holds up the office) ---

const run = promisify(execFile);
const out = async (cmd: string, args: string[], timeout: number) => (await run(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout })).stdout;
export const OWNER_APPS = ['Simulator', 'Xcode'];

export async function bootedSims(): Promise<{ udid: string; name: string }[]> {
  try {
    const j = JSON.parse(await out('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], 20_000)) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
    return Object.values(j.devices).flat().filter((d) => d.state === 'Booted').map((d) => ({ udid: d.udid, name: d.name }));
  } catch {
    return [];
  }
}

export async function frontApp(): Promise<string> {
  try {
    const asn = (await out('lsappinfo', ['front'], 5000)).trim();
    return /"([^"]+)"/.exec(await out('lsappinfo', ['info', '-only', 'name', asn], 5000))?.[1] ?? '';
  } catch {
    return '';
  }
}

export async function processes(): Promise<Proc[]> {
  try {
    return parsePs(await out('ps', ['-Ao', 'pid=,cputime=,etime=,command='], 20_000));
  } catch {
    return [];
  }
}

export async function stopSim(udid: string): Promise<boolean> {
  try {
    await run('xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export const hogLine = (h: { proc: Proc; share: number }) =>
  `${nameOf(h.proc.command)} (pid ${h.proc.pid}) has used ${Math.round(h.share * 100)}% of a CPU core for the last hour and has been running ${Math.round(h.proc.ageSec / 3600)} h`;
