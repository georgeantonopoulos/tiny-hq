// Reaching the office from the owner's phone, over their own Tailscale network.
//
// The daemon still listens on 127.0.0.1 only. `tailscale serve` (never Funnel)
// passes HTTPS requests for the Mac's ts.net name through to it and adds who
// sent them (Tailscale-User-Login). A remote request needs two locks:
//   1. it comes from the owner's Tailscale account, and
//   2. it carries a key for a device they paired, from a one-time link made on
//      the Mac. The Mac's own token is never accepted from outside.
// Sign-in links can't be made remotely, sign-ins are rate-limited, and every
// pairing, refusal and session is written to an audit log.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RemoteConfig {
  host: string; // e.g. my-mac.tail1234ab.ts.net
  login: string; // the only Tailscale account allowed in
}

export interface Device {
  id: string;
  label: string;
  hash: string; // sha256 of the key; the key itself is never stored
  pairedAt: number;
  lastSeen: number;
}

// A paired device that isn't used for this long has to be paired again.
export const DEVICE_IDLE_MS = 30 * 24 * 3600_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class Devices {
  readonly #path: string;
  readonly #now: () => number;
  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  list(): Device[] {
    if (!existsSync(this.#path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as Device[]).filter((d) => d && typeof d.hash === 'string' && typeof d.id === 'string') : [];
    } catch {
      return [];
    }
  }

  #save(list: Device[]): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
  }

  // Returns the new device's key (shown to its browser once, never again).
  pair(label: string): { device: Device; key: string } {
    const key = randomBytes(32).toString('hex');
    const now = this.#now();
    const device: Device = { id: randomUUID(), label: label.slice(0, 80) || 'a device', hash: sha(key), pairedAt: now, lastSeen: now };
    const list = this.list().filter((d) => now - d.lastSeen < DEVICE_IDLE_MS).slice(-19);
    this.#save([...list, device]);
    return { device, key };
  }

  // The device holding this key, if it's still paired; marks it as seen.
  check(key: string | undefined): Device | undefined {
    if (!key || !/^[0-9a-f]{64}$/.test(key)) return undefined;
    const want = Buffer.from(sha(key));
    const now = this.#now();
    const list = this.list();
    const d = list.find((x) => x.hash.length === want.length && timingSafeEqual(Buffer.from(x.hash), want));
    if (!d || now - d.lastSeen >= DEVICE_IDLE_MS) return undefined;
    if (now - d.lastSeen > 60_000) {
      d.lastSeen = now;
      this.#save(list);
    }
    return d;
  }

  revoke(id: string): boolean {
    const list = this.list();
    const next = list.filter((d) => d.id !== id);
    if (next.length === list.length) return false;
    this.#save(next);
    return true;
  }
}

// At most `max` tries per window; used for remote sign-ins.
export class RateLimit {
  readonly #hits: number[] = [];
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }
  allow(): boolean {
    const t = this.#now();
    while (this.#hits.length && t - this.#hits[0]! > this.#windowMs) this.#hits.shift();
    if (this.#hits.length >= this.#max) return false;
    this.#hits.push(t);
    return true;
  }
}

export function audit(path: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch {
    // auditing must never take the office down
  }
}

// The config entry, if remote access is switched on and looks sane.
export function remoteFrom(raw: unknown): RemoteConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { host?: unknown; login?: unknown };
  if (typeof r.host !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(r.host)) return undefined;
  if (typeof r.login !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(r.login)) return undefined;
  return { host: r.host.toLowerCase(), login: r.login.toLowerCase() };
}
