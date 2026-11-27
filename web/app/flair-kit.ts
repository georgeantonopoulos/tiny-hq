// Each room's own flair: a personal touch and small animations for every room, based on the project
// it works on, by default for new rooms too. A Sonnet writer reads a little about the project and answers with data only: a tiny animated
// pixel emblem for the wall, two gentle colours, a motto for the plaque and one ambient effect picked
// from the kit below. Tiny HQ draws all of it (flair.ts); nothing the writer sends ever runs.
// Shared by the daemon (validating the writer's answer) and the page (validating what it reads).

export const AMBIENTS = ['sparkle', 'bubbles', 'motes', 'orbit', 'pulse', 'steam', 'blink', 'bits', 'leaves', 'ripple'] as const;
export type Ambient = (typeof AMBIENTS)[number];

export const EMBLEM_SIZE = 12; // pixels each way
export const MAX_FRAMES = 4;
export const MAX_COLOURS = 6;

export interface Emblem {
  frames: string[][]; // 2-4 frames; each 12 rows of 12 palette letters, '.' for clear
  palette: Record<string, string>; // letter -> #rrggbb
  fps: number; // 1-8
}

export interface Flair {
  motif: string; // what the emblem shows, in a few words
  motto?: string; // a few words on the plaque under it
  wall?: string; // pale tints for the room, #rrggbb
  floor?: string;
  emblem: Emblem;
  ambient?: { kind: Ambient; colour: string };
}

const HEX = /^#[0-9a-f]{6}$/i;
const plain = (s: unknown, max: number): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t || t.length > max || /[<>`{}]|https?:|www\.|@/i.test(t)) return undefined;
  return t;
};
// Walls and floors stay pale, so the room's dark name and lines still read on them.
const pale = (c: unknown): string | undefined => {
  if (typeof c !== 'string' || !HEX.test(c)) return undefined;
  const n = parseInt(c.slice(1), 16);
  return [n >> 16, (n >> 8) & 0xff, n & 0xff].every((v) => v >= 0xb0) ? c.toLowerCase() : undefined;
};

function validEmblem(x: unknown): Emblem | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (!o.palette || typeof o.palette !== 'object' || Array.isArray(o.palette)) return undefined;
  const palette: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.palette as Record<string, unknown>)) {
    if (!/^[a-z]$/i.test(k) || typeof v !== 'string' || !HEX.test(v)) return undefined;
    palette[k] = v.toLowerCase();
  }
  const keys = Object.keys(palette);
  if (!keys.length || keys.length > MAX_COLOURS) return undefined;
  if (!Array.isArray(o.frames) || o.frames.length < 2 || o.frames.length > MAX_FRAMES) return undefined;
  const frames: string[][] = [];
  for (const f of o.frames) {
    if (!Array.isArray(f) || f.length !== EMBLEM_SIZE) return undefined;
    const rows = f.map((r) => (typeof r === 'string' ? r : ''));
    if (rows.some((r) => r.length !== EMBLEM_SIZE || [...r].some((ch) => ch !== '.' && !(ch in palette)))) return undefined;
    frames.push(rows);
  }
  // Something has to show, and something has to move.
  if (!frames.some((f) => f.some((r) => /[^.]/.test(r)))) return undefined;
  if (frames.every((f) => f.join('') === frames[0]!.join(''))) return undefined;
  const fps = typeof o.fps === 'number' && Number.isFinite(o.fps) ? Math.min(8, Math.max(1, Math.round(o.fps))) : 2;
  return { frames, palette, fps };
}

// A flair from outside (the writer's answer, or the file): kept only when it fits the kit. A bad
// colour, motto or effect is dropped on its own; a bad emblem drops the whole flair.
export function validFlair(x: unknown): Flair | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  const motif = plain(o.motif, 60);
  const emblem = validEmblem(o.emblem);
  if (!motif || !emblem) return undefined;
  const f: Flair = { motif, emblem };
  const motto = plain(o.motto, 22);
  if (motto) f.motto = motto;
  const wall = pale(o.wall);
  if (wall) f.wall = wall;
  const floor = pale(o.floor);
  if (floor) f.floor = floor;
  const a = o.ambient as Record<string, unknown> | undefined;
  if (a && typeof a === 'object' && (AMBIENTS as readonly unknown[]).includes(a.kind) && typeof a.colour === 'string' && HEX.test(a.colour)) {
    f.ambient = { kind: a.kind as Ambient, colour: a.colour.toLowerCase() };
  }
  return f;
}
