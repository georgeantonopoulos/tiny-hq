// Keeps the latest floor plan. Scans run in the background; callers get the
// cached plan at once unless they ask for a fresh one or none exists yet.

import { discoverProjects } from '../discovery/scan.ts';
import { layoutFloor, type Floor } from './layout.ts';

export const FLOOR_MAX_AGE_MS = 5 * 60_000;

export class FloorCache {
  #floor: Floor | undefined;
  #scan: Promise<Floor> | undefined;
  readonly #discover: () => Promise<Floor>;

  constructor(discover: () => Promise<Floor> = async () => layoutFloor(await discoverProjects())) {
    this.#discover = discover;
  }

  latest(): Floor | undefined {
    return this.#floor;
  }

  #rescan(): Promise<Floor> {
    // Only one scan at a time; concurrent callers share it.
    this.#scan ??= this.#discover()
      .then((f) => (this.#floor = f))
      .finally(() => (this.#scan = undefined));
    return this.#scan;
  }

  async get(refresh = false): Promise<Floor> {
    if (refresh || !this.#floor) return this.#rescan();
    if (Date.now() - this.#floor.generatedAt > FLOOR_MAX_AGE_MS) void this.#rescan().catch(() => undefined);
    return this.#floor;
  }
}
