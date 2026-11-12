/// <reference lib="dom" />
// (The server-side tests import this file too, and their build has no browser types.)
// Original pixel art, drawn from code: the people in the office.
// Each sprite is a little grid of characters mapped to colours: a big-headed
// 12x16 figure, with a hairstyle and an accessory picked from their name, so
// everyone looks like themselves and keeps the same look between visits.

export type Palette = { skin: string; hair: string; shirt: string };

export const SPRITE_W = 12;
export const SPRITE_H = 16;

// The body every hairstyle sits on. S skin, E eyes, B blush, M mouth,
// C shirt, T tie, A arm (skin), P trousers, O shoes.
const BASE = [
  '............',
  '............',
  '............',
  '...SSSSSS...',
  '..SSSSSSSS..',
  '..SESSSSES..',
  '..SESSSSES..',
  '..SBSMMSBS..',
  '...SSSSSS...',
  '...CCCCCC...', // a collar: the tie starts below it, so it never reads as a tongue under the smile
  '..CCCTTCCC..',
  '.ACCCTTCCCA.',
  '.ACCCCCCCCA.',
  '..CCCCCCCC..',
  '..PPP..PPP..',
  '..OOO..OOO..',
];

// Hair over the top of the head; '.' leaves the base showing. K is the
// accessory colour (a beanie, headphones).
const HAIR = {
  short: ['....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HH......HH.', '.H........H.'],
  bob: ['...HHHHHH...', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HHH....HHH.', '.HH......HH.', '.HH......HH.', '.HH......HH.', '.HH......HH.'],
  spiky: ['..H.H.H.H...', '.HHHHHHHHHH.', '.HHHHHHHHHH.', '.HH......HH.'],
  bun: ['....HHHH....', '....HHHH....', '..HHHHHHHH..', '.HHHHHHHHHH.', '.HH......HH.'],
  curly: ['..HH.HH.HH..', '.HHHHHHHHHH.', 'HHHHHHHHHHHH', 'HHH......HHH', 'HH........HH', 'HH........HH'],
  beanie: ['....KKKK....', '..KKKKKKKK..', '.KKKKKKKKKK.', '.KKKKKKKKKK.', '.HH......HH.'],
  // The manager's old look: what was left of it, on the sides (unused since the manager grew hair).
  balding: ['............', '............', '...SSSSSS...', '.HSSSSSSSSH.', '.HH......HH.'],
} as const;
type Hair = keyof typeof HAIR;
const STYLES: Hair[] = ['short', 'bob', 'spiky', 'bun', 'curly', 'beanie'];
type Extra = 'none' | 'glasses' | 'headphones';
const EXTRAS: Extra[] = ['none', 'glasses', 'none', 'headphones', 'none'];
const ACCESSORY = ['#4f9a5c', '#3a9bb5', '#e07a5f', '#7a5cc2', '#2a2a3a'];

export interface Look {
  hair: Hair;
  extra: Extra;
  accessory: string;
  cute?: boolean; // rounder face, big blush, a smile
  hat?: 'propeller'; // a rainbow propeller cap over everything above the eyes
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Same name, same look, every time.
export function lookFor(name: string): Look {
  if (name === 'Manager') return { hair: 'short', extra: 'glasses', accessory: '#2a2a3a', cute: true, hat: 'propeller' }; // The manager: hair, glasses, a round cute face and a rainbow propeller cap
  const h = hash(name);
  return { hair: STYLES[h % STYLES.length]!, extra: EXTRAS[(h >>> 8) % EXTRAS.length]!, accessory: ACCESSORY[(h >>> 16) % ACCESSORY.length]! };
}

export type Frame = 'idle' | 'blink' | 'stepA' | 'stepB';

// The manager wears a red tie; leads wear one in their shirt colour, a shade darker.
export function personPixels(p: Palette, tie = '#d8443c', frame: Frame = 'idle', look: Look = lookFor('')): (string | null)[][] {
  const g = BASE.map((r) => [...r]);
  HAIR[look.hair].forEach((row, j) => [...row].forEach((ch, i) => ch !== '.' && (g[j]![i] = ch)));
  if (look.extra === 'glasses') {
    g[5] = [...'.GGGGGGGGGG.'];
    g[6] = [...'..GEGSSGEG..'];
  } else if (look.extra === 'headphones') {
    g[2] = [...'.KKKKKKKKKK.'];
    for (const j of [4, 5, 6]) {
      g[j]![1] = 'K';
      g[j]![10] = 'K';
    }
  }
  if (look.cute) {
    g[4] = [...'.SSSSSSSSSS.'];
    if (look.extra === 'glasses') {
      // Round clear glasses: small slate-blue rims (R) around each eye, a bridge between,
      // and their smile below. Lighter than their eyes, so the eyes still read through the lenses.
      g[5] = [...'.SRRSSSSRRS.'];
      g[6] = [...'.RSERRRRESR.'];
      g[7] = [...'.SRRSSSSRRS.'];
      g[8] = [...'..SSSMMSSS..'];
      if (frame === 'blink') (g[6]![3] = 'S'), (g[6]![8] = 'S');
    } else {
      g[6] = [...'.SSESSSSESS.'];
      g[7] = [...'.SBBSMMSBBS.'];
      g[8] = [...'..SSSSSSSS..'];
      if (frame === 'blink') {
        g[6]![3] = 'S';
        g[6]![8] = 'S';
      }
    }
  }
  if (look.hat === 'propeller') {
    // A spinning-looking propeller on a stripy rainbow cap; the hair peeks out at the sides.
    g[0] = [...'.....ww.....'];
    g[1] = [...(frame === 'stepA' || frame === 'blink' ? '.bbggwwyyrr.' : '.rryywwggbb.')]; // the blades swap sides as they walk
    g[2] = [...'...rygbvr...'];
    g[3] = [...'..rygbvryg..'];
    g[4] = [...'.HrygbvrygH.'];
  }
  if (frame === 'blink' && look.extra !== 'glasses') {
    g[5]![3] = 'S';
    g[5]![8] = 'S';
  }
  if (frame === 'stepA') {
    g[14] = [...'.PPP....PPP.'];
    g[15] = [...'.OOO....OOO.'];
  } else if (frame === 'stepB') {
    g[14] = [...'...PPPPPP...'];
    g[15] = [...'...OOOOOO...'];
  }
  const map: Record<string, string | null> = {
    '.': null,
    H: p.hair,
    S: p.skin,
    A: p.skin,
    E: '#2a2230',
    B: '#f19a8f',
    M: '#9c4a4a',
    C: p.shirt,
    T: tie,
    P: '#3a3550',
    O: '#1f1b2b',
    K: look.accessory,
    G: '#222030',
    R: '#3f5d8c',
    r: '#e8453c',
    y: '#f6c945',
    g: '#58b368',
    b: '#4a90d9',
    v: '#8a5cc2',
    w: '#d9dde6',
  };
  return g.map((row) => row.map((ch) => map[ch] ?? null));
}

// Draws a pixel grid into a PIXI.Graphics at (x, y) with the given pixel size.
export function drawPixels(g: import('pixi.js').Graphics, px: (string | null)[][], x: number, y: number, size: number): void {
  px.forEach((row, j) =>
    row.forEach((c, i) => {
      if (c) g.rect(x + i * size, y + j * size, size, size).fill(c);
    }),
  );
}

// Same grid onto a 2D canvas (used for the chat avatar).
export function paintCanvas(canvas: HTMLCanvasElement, px: (string | null)[][]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = Math.floor(Math.min(canvas.width / SPRITE_W, canvas.height / SPRITE_H));
  const ox = Math.floor((canvas.width - SPRITE_W * size) / 2);
  const oy = canvas.height - SPRITE_H * size;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  px.forEach((row, j) =>
    row.forEach((c, i) => {
      if (!c) return;
      ctx.fillStyle = c;
      ctx.fillRect(ox + i * size, oy + j * size, size, size);
    }),
  );
}

export function darker(hex: string, by = 0.25): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.round(v * (1 - by)));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('')}`;
}
