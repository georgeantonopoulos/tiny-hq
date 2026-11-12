// How much work the office may start on its own right now. With a usage meter set
// (config "usageCommand": any local command that prints the usage JSON below), it follows the
// owner's Claude allowance, when its 5-hour and weekly windows reset, and how many rooms are
// already working. With no meter, it's the owner's own fixed number (config "goalRooms").
//
// The rule, in plain words:
// - How far behind an even pace through the week the owner's use is ("in reserve"): 5%+ one
//   room at once, 15%+ two, 30%+ three.
// - A quiet 5-hour window (under 30%) is lost if unused: one room, while half the week is left.
// - The last day before the weekly reset, a lot left over is use-it-or-lose-it: one more room.
// - The 5-hour window caps it: past half used, one room at most; nearly used, none until it resets.
// - Rooms already working (The owner's own, jobs, earlier goal steps) take their places first.
// - A meter is set but can't be read: nothing starts on its own. The owner's own asks never wait on this.

import { execFile } from 'node:child_process';

export interface Window {
  usedPercent: number;
  resetsAt?: number; // ms
}

export interface Usage {
  session?: Window; // the rolling 5-hour window
  weekly?: Window;
  at: number; // when it was read
}

export interface Plan {
  rooms: number; // how many rooms may work on their own at once (before subtracting busy ones)
  free: number; // how many more may start now
  why: string; // one plain line for the owner and the manager
}

export const MAX_ROOMS = 3;
export const STALE_MS = 30 * 60_000;

const windowOf = (w: unknown): Window | undefined => {
  if (!w || typeof w !== 'object') return undefined;
  const o = w as { usedPercent?: unknown; resetsAt?: unknown };
  if (typeof o.usedPercent !== 'number' || !Number.isFinite(o.usedPercent)) return undefined;
  const at = typeof o.resetsAt === 'string' ? Date.parse(o.resetsAt) : NaN;
  return { usedPercent: Math.max(0, Math.min(100, o.usedPercent)), ...(Number.isFinite(at) ? { resetsAt: at } : {}) };
};

export type Provider = 'claude' | 'codex';
export const PROVIDERS: readonly Provider[] = ['claude', 'codex'];

// One provider's numbers from the meter's JSON: one row or a list of rows like
// {"provider": "claude", "usage": {"primary": {"usedPercent": 12, "resetsAt": "<ISO time>"}, "secondary": {...}}},
// primary being the 5-hour window and secondary the week.
export function parseUsage(stdout: string, now = Date.now(), provider: Provider = 'claude'): Usage | undefined {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const row = (Array.isArray(rows) ? rows : [rows]).find((r) => r && typeof r === 'object' && (r as { provider?: unknown }).provider === provider) as { usage?: { primary?: unknown; secondary?: unknown } } | undefined;
  if (!row?.usage) return undefined;
  const session = windowOf(row.usage.primary);
  const weekly = windowOf(row.usage.secondary);
  if (!session && !weekly) return undefined;
  return { ...(session ? { session } : {}), ...(weekly ? { weekly } : {}), at: now };
}

// A window that has already reset counts as unused.
const used = (w: Window | undefined, now: number): number => (!w ? 0 : w.resetsAt !== undefined && w.resetsAt <= now ? 0 : w.usedPercent);

const clock = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function plan(u: Usage | undefined, now: number, busy: number, max = MAX_ROOMS, fixed?: number): Plan {
  const none = (why: string): Plan => ({ rooms: 0, free: 0, why });
  if (fixed !== undefined) {
    const rooms = Math.max(0, Math.min(max, fixed));
    if (!rooms) return none('goal steps are off in your settings');
    return { rooms, free: Math.max(0, rooms - busy), why: `no usage meter set: up to ${rooms} room${rooms === 1 ? '' : 's'} at once (your setting), ${busy} busy` };
  }
  if (!u || now - u.at > STALE_MS) return none("can't read the Claude allowance, so nothing starts on its own");
  const five = used(u.session, now);
  const week = used(u.weekly, now);
  const fiveBack = u.session?.resetsAt && u.session.resetsAt > now ? ` (resets ${clock(u.session.resetsAt)})` : '';
  const weekBack = u.weekly?.resetsAt && u.weekly.resetsAt > now ? ` (resets ${clock(u.weekly.resetsAt)})` : '';
  if (week >= 90) return none(`weekly allowance ${week}% used${weekBack}: resting until it resets`);
  if (five >= 80) return none(`5-hour window ${five}% used${fiveBack}: resting until it resets`);
  const hoursLeft = u.weekly?.resetsAt && u.weekly.resetsAt > now ? Math.min(168, (u.weekly.resetsAt - now) / 3_600_000) : 168;
  // In reserve: how far behind an even pace through the week the owner's use is ("17% in reserve").
  const reserve = Math.round((100 * (168 - hoursLeft)) / 168 - week);
  let rooms = reserve >= 30 ? 3 : reserve >= 15 ? 2 : reserve >= 5 ? 1 : 0;
  // A quiet 5-hour window is lost if nobody uses it: one room, as long as half the week is left.
  if (five < 30 && week <= 50) rooms = Math.max(rooms, 1);
  // The last day before the weekly reset, a lot left over is use-it-or-lose-it.
  const loseIt = hoursLeft <= 24 && 100 - week >= 25;
  if (loseIt) rooms += 1;
  if (five >= 50) rooms = Math.min(rooms, 1);
  rooms = Math.max(0, Math.min(max, rooms));
  const free = Math.max(0, rooms - busy);
  const why =
    `week ${week}% used${weekBack}, ${reserve >= 0 ? `${reserve}% in reserve` : `${-reserve}% ahead of pace`}, 5-hour ${five}% used${fiveBack}` +
    (loseIt ? ', weekly reset soon with plenty left' : '') +
    `: up to ${rooms} room${rooms === 1 ? '' : 's'} at once, ${busy} busy`;
  return { rooms, free, why };
}

// The owner's usage meter, if they set one: run without a shell, its input closed (a meter
// waiting on a pipe would otherwise hang), killed after 90 seconds.
export function usageReader(command: readonly string[] | undefined): ((p: Provider) => Promise<string>) | undefined {
  if (!command?.length) return undefined;
  return (provider) =>
    new Promise((resolve, reject) => {
      const [bin, ...args] = command.map((a) => a.replaceAll('{provider}', provider));
      const child = execFile(bin!, args, { timeout: 90_000, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, out) => (err ? reject(err) : resolve(out)));
      child.stdin?.end();
    });
}

// The allowance, re-read at most every 5 minutes in the background, for Claude (which
// steers goal steps) and Codex (shown on the usage board). A failed read keeps the last
// good one (and it goes stale after 30 minutes, which stops autonomy).
export class Allowance {
  #last = new Map<Provider, Usage>();
  #at = 0;
  #pending: Promise<void> | undefined;
  readonly read: (p: Provider) => Promise<string>;
  readonly metered: boolean; // no meter set: nothing to read, and nothing logged
  readonly now: () => number;
  constructor(read?: (p: Provider) => Promise<string>, now: () => number = Date.now) {
    this.metered = !!read;
    this.read = read ?? (() => Promise.reject(new Error('no usage meter set')));
    this.now = now;
  }
  latest(p: Provider = 'claude'): Usage | undefined {
    return this.#last.get(p);
  }
  refresh(): Promise<void> {
    if (!this.metered) return Promise.resolve();
    if (this.now() - this.#at < 5 * 60_000) return Promise.resolve();
    this.#pending ??= (async () => {
      for (const p of PROVIDERS) {
        try {
          const u = parseUsage(await this.read(p), this.now(), p);
          if (u) this.#last.set(p, u);
        } catch (err) {
          console.error(`allowance: could not read ${p} from the usage meter:`, String(err).slice(0, 200));
        }
      }
    })().finally(() => {
      this.#at = this.now();
      this.#pending = undefined;
    });
    return this.#pending;
  }
}

// The usage board: plain numbers per provider, for the bar at the top of the office.
export interface Meter {
  provider: Provider;
  fiveHour?: { used: number; resetsAt?: number };
  week?: { used: number; resetsAt?: number };
  at: number; // when the meter was read
  stale: boolean;
}
export function meters(a: Allowance, now = Date.now()): Meter[] {
  return PROVIDERS.flatMap((p) => {
    const u = a.latest(p);
    if (!u) return [];
    const w = (x: Window | undefined) => (x ? { used: used(x, now), ...(x.resetsAt && x.resetsAt > now ? { resetsAt: x.resetsAt } : {}) } : undefined);
    const five = w(u.session);
    const week = w(u.weekly);
    return [{ provider: p, ...(five ? { fiveHour: five } : {}), ...(week ? { week } : {}), at: u.at, stale: now - u.at > STALE_MS }];
  });
}
