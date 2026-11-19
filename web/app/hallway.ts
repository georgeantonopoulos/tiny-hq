// Procedural pixel-art renderer for the office hallways, building shell,
// and common zones (atrium, lounges, rec corner, copy/snack
// alcoves, and planters). Drawn with clean integer-aligned flat fills (no thin
// jagged strokes) and a calm, dimmed daytime palette so the lit rooms and
// workers stay the unmistakable focal point.

import type { Floor } from '../../src/office/layout.ts';
import type { FloorPlan, FloorZone } from './floorplan.ts';
import { TILE } from './furniture.ts';

type Container = import('pixi.js').Container;
type Graphics = import('pixi.js').Graphics;

export interface HallwayTheme {
  night: boolean;
  edge: number;
  trim: number;
  desk: number;
  deskTop: number;
  pot: number;
  potRim: number;
  leaves: number[];
  corridorOverride?: number; // already dimmed for night if applicable
}

interface Palette {
  stoneA: number;
  stoneB: number;
  grout: number;
  runner: number;
  runnerShade: number;
  runnerTrim: number;
  mat: number;
  matTrim: number;
  alcove: number;
  alcoveRim: number;
  shellWall: number;
  shellTrim: number;
  mossDark: number;
  stoneCurb: number;
  stoneDark: number;
  waterOuter: number;
  waterInner: number;
  waterGlint: number;
  wood: number;
  woodTop: number;
  woodDark: number;
  atriumFloor: number;
  atriumAlt: number;
  atriumBorder: number;
  recMat: number;
  recMatInner: number;
  pingPong: number;
  pingPongLine: number;
  metal: number;
  metalDark: number;
  metalLight: number;
  paper: number;
  vending: number;
  vendingGlass: number;
  waterJug: number;
  lantern: number;
  lanternGlow: number;
  pot: number;
  potRim: number;
  leaves: [number, number, number];
  rugs: number[];
  pillow: number;
  stools: [number, number, number, number];
}

function shift(hex: number, delta: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((hex >> 16) & 255) + delta);
  const g = clamp(((hex >> 8) & 255) + delta);
  const b = clamp((hex & 255) + delta);
  return (r << 16) | (g << 8) | b;
}

function makePalette(th: HallwayTheme): Palette {
  if (th.night) {
    const stoneA = th.corridorOverride ?? 0x262436;
    return {
      stoneA,
      stoneB: shift(stoneA, -4),
      grout: shift(stoneA, -12),
      runner: 0x343a54,
      runnerShade: 0x2c3148,
      runnerTrim: 0x625a70,
      mat: 0x523838,
      matTrim: 0x7d6354,
      alcove: shift(stoneA, -5),
      alcoveRim: shift(stoneA, 6),
      shellWall: 0x171526,
      shellTrim: 0x3b334f,
      mossDark: 0x213b30,
      stoneCurb: 0x454154,
      stoneDark: 0x2f2c3c,
      waterOuter: 0x234659,
      waterInner: 0x1a3748,
      waterGlint: 0x467a96,
      wood: 0x523932,
      woodTop: 0x66483e,
      woodDark: 0x3c2924,
      atriumFloor: 0x2d2a3d,
      atriumAlt: 0x2a2739,
      atriumBorder: 0x403b54,
      recMat: 0x284044,
      recMatInner: 0x335256,
      pingPong: 0x1e4261,
      pingPongLine: 0x9aa9bd,
      metal: 0x5a5e70,
      metalDark: 0x383b4a,
      metalLight: 0x777c91,
      paper: 0xa6a3b5,
      vending: 0x34475c,
      vendingGlass: 0x597a99,
      waterJug: 0x4889ab,
      lantern: 0x5c5666,
      lanternGlow: 0xffc766,
      pot: 0x6e4335,
      potRim: 0x7d4e3e,
      leaves: [0x265241, 0x316650, 0x3c785b],
      rugs: [0x613c3d, 0x38524e, 0x61523d, 0x384763, 0x52415e, 0x5e463e],
      pillow: 0xb09362,
      stools: [0x475c7a, 0x7d4539, 0x476959, 0x856f49],
    };
  }
  // Daytime: deliberately calm, grounded warm stone & muted accents so the
  // sunlit wooden rooms and workers remain the brightest focal point.
  const stoneA = th.corridorOverride ?? 0x746c64;
  return {
    stoneA,
    stoneB: shift(stoneA, -5),
    grout: shift(stoneA, -18),
    runner: 0x4e5c66,
    runnerShade: 0x46535c,
    runnerTrim: 0x998e7c,
    mat: 0x754246,
    matTrim: 0xad9c84,
    alcove: shift(stoneA, -9),
    alcoveRim: shift(stoneA, 7),
    shellWall: 0x4d3829,
    shellTrim: 0x6e533e,
    mossDark: 0x36633e,
    stoneCurb: 0x635e58,
    stoneDark: 0x4d4843,
    waterOuter: 0x3f758a,
    waterInner: 0x316175,
    waterGlint: 0x73a8bd,
    wood: 0x734c34,
    woodTop: 0x8a5e40,
    woodDark: 0x543624,
    atriumFloor: 0x827a70,
    atriumAlt: 0x7d756b,
    atriumBorder: 0x665e55,
    recMat: 0x4e6e68,
    recMatInner: 0x597d76,
    pingPong: 0x2b5882,
    pingPongLine: 0xd4d0c5,
    metal: 0x999ca3,
    metalDark: 0x575b63,
    metalLight: 0xb3b6bd,
    paper: 0xd9d4c7,
    vending: 0x355363,
    vendingGlass: 0x8bb0c4,
    waterJug: 0x63a9cc,
    lantern: 0x6e6861,
    lanternGlow: 0xf2c872,
    pot: 0x9c5536,
    potRim: 0xad6442,
    leaves: [0x347042, 0x45854f, 0x5a995c],
    rugs: [0x945d4d, 0x587a69, 0x968056, 0x556c8a, 0x7d6482, 0x946c51],
    pillow: 0xbfa373,
    stools: [0x5e7699, 0xa8604d, 0x5f8572, 0xb59a69],
  };
}

const ri = (n: number): number => Math.round(n);

function softGlow(g: Graphics, x: number, y: number, r: number, color: number, alpha: number): void {
  const cx = ri(x);
  const cy = ri(y);
  for (let i = 8; i >= 1; i--) g.circle(cx, cy, ri((r * i) / 8)).fill({ color, alpha: alpha / 8 });
}

// Smooth, chunky plant matching office.ts proportions (integer coordinates, zero fractional scaling).
function drawPlant(g: Graphics, x: number, y: number, p: Palette, compact = false): void {
  const px = ri(x);
  const py = ri(y);
  if (compact) {
    g.ellipse(px + 9, py + 22, 8, 3).fill({ color: 0x000000, alpha: 0.16 });
    g.rect(px + 4, py + 14, 10, 8).fill(p.pot);
    g.rect(px + 2, py + 12, 14, 3).fill(p.potRim);
    g.circle(px + 9, py + 8, 6).fill(p.leaves[0]);
    g.circle(px + 5, py + 9, 4).fill(p.leaves[1]);
    g.circle(px + 13, py + 9, 4).fill(p.leaves[1]);
    g.circle(px + 8, py + 4, 4).fill(p.leaves[2]);
    return;
  }
  g.ellipse(px + 12, py + 31, 10, 3).fill({ color: 0x000000, alpha: 0.16 });
  g.rect(px + 5, py + 19, 14, 12).fill(p.pot);
  g.rect(px + 3, py + 17, 18, 4).fill(p.potRim);
  g.circle(px + 12, py + 10, 8).fill(p.leaves[0]);
  g.circle(px + 6, py + 12, 5).fill(p.leaves[1]);
  g.circle(px + 18, py + 12, 5).fill(p.leaves[1]);
  g.circle(px + 9, py + 4, 5).fill(p.leaves[2]);
  g.circle(px + 15, py + 5, 4).fill(p.leaves[2]);
}

function drawTree(g: Graphics, cx: number, cy: number, p: Palette, r = 14): void {
  const x = ri(cx);
  const y = ri(cy);
  g.ellipse(x, y + ri(r * 0.85), ri(r * 0.85), ri(r * 0.35)).fill({ color: 0x000000, alpha: 0.18 });
  g.rect(x - 3, y + 2, 6, ri(r * 0.8)).fill(p.woodDark);
  g.circle(x, y, r).fill(p.leaves[0]);
  g.circle(x - ri(r * 0.45), y - ri(r * 0.15), ri(r * 0.6)).fill(p.leaves[1]);
  g.circle(x + ri(r * 0.45), y - ri(r * 0.1), ri(r * 0.55)).fill(p.leaves[1]);
  g.circle(x - 1, y - ri(r * 0.45), ri(r * 0.5)).fill(p.leaves[2]);
}

function drawBookshelf(g: Graphics, x: number, y: number, w: number, h: number, p: Palette, night: boolean): void {
  const bx = ri(x);
  const by = ri(y);
  const bw = ri(w);
  const bh = ri(h);
  g.rect(bx, by + 2, bw, bh).fill({ color: 0x000000, alpha: 0.16 });
  g.rect(bx, by, bw, bh).fill(p.woodDark);
  g.rect(bx + 2, by + 2, bw - 4, bh - 4).fill(p.wood);
  const rows = Math.max(2, Math.floor((bh - 4) / 10));
  const rowH = Math.floor((bh - 4) / rows);
  const spines = night
    ? [0x70373b, 0x38614e, 0x7d6335, 0x335c73, 0x544178]
    : [0x994947, 0x457d4f, 0xb0823a, 0x3a7a8f, 0x685299];
  for (let r = 0; r < rows; r++) {
    const sy = by + 2 + r * rowH;
    g.rect(bx + 2, sy + rowH - 2, bw - 4, 2).fill(p.woodDark);
    const cols = Math.floor((bw - 8) / 6);
    for (let c = 0; c < cols; c++) {
      if ((c + r * 3) % 7 === 0) continue;
      const bookH = Math.max(4, rowH - 3 - ((c + r) % 2));
      g.rect(bx + 4 + c * 6, sy + rowH - 2 - bookH, 4, bookH).fill(spines[(c * 3 + r) % spines.length]!);
    }
  }
}

function drawVending(g: Graphics, x: number, y: number, p: Palette, night: boolean): void {
  const vx = ri(x);
  const vy = ri(y);
  if (night) softGlow(g, vx + 14, vy + 20, 40, 0x8ad8ff, 0.24);
  g.roundRect(vx + 2, vy + 3, 28, 38, 3).fill({ color: 0x000000, alpha: 0.18 });
  g.roundRect(vx, vy, 28, 38, 3).fill(p.vending);
  g.rect(vx + 2, vy + 2, 24, 3).fill(shift(p.vending, 14));
  // Glass display with chunky pixel snack blocks.
  g.rect(vx + 3, vy + 6, 16, 20).fill(p.vendingGlass);
  const snacks = night
    ? [0xb54b4b, 0xc29e3e, 0x4f966a, 0xbd7344, 0x725ca3]
    : [0xb84f4f, 0xc7a344, 0x52996a, 0xc27848, 0x7660a6];
  for (let row = 0; row < 3; row++) {
    g.rect(vx + 4, vy + 12 + row * 6, 14, 2).fill({ color: 0x1d2533, alpha: 0.35 });
    for (let col = 0; col < 3; col++) {
      g.rect(vx + 5 + col * 4, vy + 8 + row * 6, 3, 4).fill(snacks[(row * 3 + col) % snacks.length]!);
    }
  }
  g.rect(vx + 21, vy + 8, 4, 10).fill(p.metalDark);
  g.rect(vx + 22, vy + 9, 2, 2).fill(0x5eb87a);
  g.rect(vx + 22, vy + 13, 2, 2).fill(0xd9a33f);
  g.rect(vx + 4, vy + 29, 15, 6).fill(0x1f222e);
}

function drawWatercooler(g: Graphics, x: number, y: number, p: Palette): void {
  const wx = ri(x);
  const wy = ri(y);
  g.ellipse(wx + 10, wy + 34, 9, 3).fill({ color: 0x000000, alpha: 0.16 });
  g.rect(wx + 3, wy + 16, 14, 18).fill(p.metalLight);
  g.rect(wx + 3, wy + 16, 14, 3).fill(p.metal);
  g.rect(wx + 5, wy + 21, 10, 6).fill(p.metalDark);
  g.rect(wx + 6, wy + 22, 2, 2).fill(0xb8443e);
  g.rect(wx + 12, wy + 22, 2, 2).fill(0x467fb8);
  g.roundRect(wx + 4, wy + 3, 12, 13, 4).fill({ color: p.waterJug, alpha: 0.85 });
  g.rect(wx + 6, wy + 5, 2, 8).fill({ color: 0xffffff, alpha: 0.35 });
  g.rect(wx + 18, wy + 20, 4, 8).fill(p.paper);
}

function drawCopier(g: Graphics, x: number, y: number, p: Palette, night: boolean): void {
  const cx = ri(x);
  const cy = ri(y);
  g.roundRect(cx + 2, cy + 5, 36, 29, 3).fill({ color: 0x000000, alpha: 0.16 });
  g.roundRect(cx, cy + 6, 34, 26, 3).fill(p.metal);
  g.rect(cx + 2, cy + 2, 30, 8).fill(p.metalLight);
  g.rect(cx + 4, cy + 4, 22, 3).fill(p.metalDark);
  g.rect(cx + 4, cy + 14, 26, 6).fill(p.metalLight);
  g.rect(cx + 14, cy + 16, 6, 2).fill(p.metalDark);
  g.rect(cx + 4, cy + 22, 26, 7).fill(p.metalLight);
  g.rect(cx + 14, cy + 25, 6, 2).fill(p.metalDark);
  g.rect(cx + 32, cy + 11, 8, 5).fill(p.paper);
  g.rect(cx + 28, cy + 5, 3, 2).fill(0x5ee08a);
  if (night) softGlow(g, cx + 29, cy + 6, 12, 0x5ee08a, 0.35);
}

function drawRecyclingBins(g: Graphics, x: number, y: number, night: boolean): void {
  const bx = ri(x);
  const by = ri(y);
  const blue = night ? 0x2b4e73 : 0x416e9e;
  const green = night ? 0x29543e : 0x437d56;
  for (const [dx, col] of [
    [0, blue],
    [13, green],
  ] as const) {
    g.rect(bx + dx, by + 2, 11, 14).fill(col);
    g.rect(bx + dx - 1, by, 13, 3).fill(shift(col, 14));
    g.rect(bx + dx + 3, by + 6, 5, 4).fill({ color: 0xffffff, alpha: 0.32 });
  }
}

function drawBench(g: Graphics, x: number, y: number, w: number, h: number, vertical: boolean, p: Palette, cushionCol: number): void {
  const bx = ri(x);
  const by = ri(y);
  const bw = ri(w);
  const bh = ri(h);
  g.roundRect(bx + 2, by + 3, bw, bh, 4).fill({ color: 0x000000, alpha: 0.18 });
  g.roundRect(bx, by, bw, bh, 4).fill(p.wood);
  if (!vertical) {
    g.rect(bx + 2, by + 2, bw - 4, 4).fill(p.woodDark);
    g.rect(bx + 2, by + 8, bw - 4, 4).fill(p.woodTop);
    g.rect(bx + 2, by + bh - 6, bw - 4, 4).fill(p.woodTop);
    g.rect(bx, by + 2, 4, bh - 4).fill(p.woodDark);
    g.rect(bx + bw - 4, by + 2, 4, bh - 4).fill(p.woodDark);
    if (bw >= 46) g.roundRect(bx + 8, by + 7, 14, bh - 11, 3).fill(cushionCol);
  } else {
    g.rect(bx + 2, by + 2, 4, bh - 4).fill(p.woodDark);
    g.rect(bx + 8, by + 2, 4, bh - 4).fill(p.woodTop);
    g.rect(bx + bw - 6, by + 2, 4, bh - 4).fill(p.woodTop);
    g.rect(bx + 2, by, bw - 4, 4).fill(p.woodDark);
    g.rect(bx + 2, by + bh - 4, bw - 4, 4).fill(p.woodDark);
    if (bh >= 46) g.roundRect(bx + 7, by + 8, bw - 11, 14, 3).fill(cushionCol);
  }
}

function drawSofa(g: Graphics, x: number, y: number, w: number, h: number, colour: number, pillow: number): void {
  const sx = ri(x);
  const sy = ri(y);
  const sw = ri(w);
  const sh = ri(h);
  const dark = shift(colour, -20);
  const light = shift(colour, 14);
  g.roundRect(sx + 2, sy + 3, sw, sh, 6).fill({ color: 0x000000, alpha: 0.18 });
  if (sw >= sh) {
    g.roundRect(sx, sy, sw, sh, 5).fill(colour);
    g.roundRect(sx + 2, sy + 2, sw - 4, Math.max(8, ri(sh * 0.34)), 4).fill(dark);
    g.roundRect(sx, sy + 4, 7, sh - 6, 3).fill(dark);
    g.roundRect(sx + sw - 7, sy + 4, 7, sh - 6, 3).fill(dark);
    const cw = Math.floor((sw - 20) / 2);
    g.roundRect(sx + 9, sy + ri(sh * 0.4), cw, ri(sh * 0.48), 3).fill(light);
    g.roundRect(sx + sw - 9 - cw, sy + ri(sh * 0.4), cw, ri(sh * 0.48), 3).fill(light);
    g.roundRect(sx + 10, sy + ri(sh * 0.32), 11, 9, 3).fill(pillow);
  } else {
    g.roundRect(sx, sy, sw, sh, 5).fill(colour);
    g.roundRect(sx + 2, sy + 2, Math.max(8, ri(sw * 0.34)), sh - 4, 4).fill(dark);
    g.roundRect(sx + 4, sy, sw - 6, 7, 3).fill(dark);
    g.roundRect(sx + 4, sy + sh - 7, sw - 6, 7, 3).fill(dark);
    const ch = Math.floor((sh - 20) / 2);
    g.roundRect(sx + ri(sw * 0.4), sy + 9, ri(sw * 0.48), ch, 3).fill(light);
    g.roundRect(sx + ri(sw * 0.4), sy + sh - 9 - ch, ri(sw * 0.48), ch, 3).fill(light);
    g.roundRect(sx + ri(sw * 0.32), sy + 10, 9, 11, 3).fill(pillow);
  }
}

function drawFloorLamp(g: Graphics, cx: number, cy: number, night: boolean): void {
  const x = ri(cx);
  const y = ri(cy);
  if (night) softGlow(g, x, y - 16, 42, 0xffd36b, 0.34);
  g.ellipse(x, y + 2, 6, 3).fill({ color: 0x000000, alpha: 0.16 });
  g.rect(x - 5, y - 1, 10, 3).fill(0x3a3346);
  g.rect(x - 1, y - 16, 3, 16).fill(0x3a3346);
  g.poly([x - 8, y - 15, x + 8, y - 15, x + 5, y - 24, x - 5, y - 24]).fill(night ? 0xffe082 : 0xcfa044);
}

// Nested solid rounded panel (replaces thin 1px strokes that alias when zoomed out).
function drawAlcovePad(g: Graphics, px: number, py: number, pw: number, ph: number, p: Palette, inset = 4): void {
  g.roundRect(px + inset, py + inset, pw - inset * 2, ph - inset * 2, 6).fill(p.alcoveRim);
  g.roundRect(px + inset + 2, py + inset + 2, pw - (inset + 2) * 2, ph - (inset + 2) * 2, 4).fill(p.alcove);
}

function drawAtrium(g: Graphics, z: FloorZone, p: Palette, night: boolean): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  // Smooth terrazzo plaza with nested border frame (zero thin stroke).
  g.rect(px, py, pw, ph).fill(p.atriumBorder);
  g.rect(px + 4, py + 4, pw - 8, ph - 8).fill(p.atriumFloor);
  for (let ty = 0; ty < z.h; ty++) {
    for (let tx = 0; tx < z.w; tx++) {
      if ((tx + ty) % 2) {
        const rx = Math.max(px + 4, px + tx * TILE);
        const ry = Math.max(py + 4, py + ty * TILE);
        const rw = Math.min(px + pw - 4, px + (tx + 1) * TILE) - rx;
        const rh = Math.min(py + ph - 4, py + (ty + 1) * TILE) - ry;
        if (rw > 0 && rh > 0) g.rect(rx, ry, rw, rh).fill(p.atriumAlt);
      }
    }
  }

  // Central sunken wooden planter island with indoor trees.
  const bedW = ri(Math.min(pw - 44, Math.max(80, pw * 0.54)));
  const bedH = ri(Math.min(ph - 52, Math.max(58, ph * 0.44)));
  const bx = ri(px + (pw - bedW) / 2);
  const by = ri(py + (ph - bedH) / 2);
  g.roundRect(bx + 2, by + 3, bedW, bedH, 8).fill({ color: 0x000000, alpha: 0.18 });
  g.roundRect(bx, by, bedW, bedH, 8).fill(p.wood);
  g.roundRect(bx + 5, by + 5, bedW - 10, bedH - 10, 5).fill(night ? 0x262129 : 0x4d3b2f);
  g.roundRect(bx + 8, by + 8, bedW - 16, bedH - 16, 4).fill(p.mossDark);

  const treeCount = bedW >= 120 ? 3 : 2;
  for (let i = 0; i < treeCount; i++) {
    const tx = ri(bx + 24 + (i * (bedW - 48)) / Math.max(1, treeCount - 1));
    const ty = by + ri(bedH / 2) + (i % 2 ? 3 : -3);
    drawTree(g, tx, ty - 6, p, 14);
  }

  // Café tables & seating (nested solid circles, zero thin stroke).
  const drawCafeTable = (tx: number, ty: number) => {
    const x = ri(tx);
    const y = ri(ty);
    g.ellipse(x, y + 8, 12, 5).fill({ color: 0x000000, alpha: 0.16 });
    g.circle(x, y, 12).fill(p.woodDark);
    g.circle(x, y, 10).fill(p.woodTop);
    g.rect(x - 4, y - 3, 4, 4).fill(p.paper);
    g.rect(x + 2, y + 1, 4, 4).fill(p.rugs[0]!);
    g.circle(x - 17, y, 5).fill(p.stools[0]);
    g.circle(x + 17, y, 5).fill(p.stools[0]);
  };
  if (by - py >= 34) {
    drawCafeTable(px + pw * 0.3, py + 22);
    if (pw >= 220) drawCafeTable(px + pw * 0.7, py + 22);
  }
  if (py + ph - (by + bedH) >= 32) {
    const bw = ri(Math.min(72, Math.max(46, bedW * 0.7)));
    drawBench(g, px + ri((pw - bw) / 2), py + ph - 26, bw, 18, false, p, p.rugs[1]!);
  }

  // Soft skylight wash by day, warm pendant pools by night.
  if (!night) {
    g.poly([px + ri(pw * 0.18), py + 6, px + ri(pw * 0.44), py + 6, px + ri(pw * 0.33), py + ph - 6, px + ri(pw * 0.08), py + ph - 6]).fill({ color: 0xfff5d6, alpha: 0.06 });
    g.poly([px + ri(pw * 0.56), py + 6, px + ri(pw * 0.82), py + 6, px + ri(pw * 0.71), py + ph - 6, px + ri(pw * 0.46), py + ph - 6]).fill({ color: 0xfff5d6, alpha: 0.06 });
  } else {
    softGlow(g, bx + bedW * 0.3, by + bedH * 0.5, 58, 0xffd36b, 0.24);
    softGlow(g, bx + bedW * 0.7, by + bedH * 0.5, 58, 0xffd36b, 0.24);
  }
}

function drawRecreation(g: Graphics, z: FloorZone, p: Palette, night: boolean): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  // Rubberized activity mat (clean nested rounded rects, no thin stroke).
  g.roundRect(px + 6, py + 6, pw - 12, ph - 12, 8).fill(p.recMat);
  g.roundRect(px + 12, py + 12, pw - 24, ph - 24, 6).fill(p.recMatInner);

  // Pixel Ping-Pong Table (solid nested fills, integer coordinates).
  const hasExtras = pw >= 210;
  const tw = ri(Math.min(112, Math.max(76, hasExtras ? pw * 0.52 : pw - 42)));
  const tht = ri(Math.min(62, Math.max(44, ph - 40)));
  const tx = hasExtras ? px + 26 : px + ri((pw - tw) / 2);
  const ty = py + ri((ph - tht) / 2);

  g.rect(tx + 3, ty + 6, tw, tht).fill({ color: 0x000000, alpha: 0.22 });
  g.rect(tx + 8, ty + tht - 2, 4, 7).fill(p.metalDark);
  g.rect(tx + tw - 12, ty + tht - 2, 4, 7).fill(p.metalDark);
  g.rect(tx, ty, tw, tht).fill(p.pingPong);
  // Crisp 2px border & center line via filled bars.
  g.rect(tx + 3, ty + 3, tw - 6, 2).fill(p.pingPongLine);
  g.rect(tx + 3, ty + tht - 5, tw - 6, 2).fill(p.pingPongLine);
  g.rect(tx + 3, ty + 3, 2, tht - 6).fill(p.pingPongLine);
  g.rect(tx + tw - 5, ty + 3, 2, tht - 6).fill(p.pingPongLine);
  g.rect(tx + 3, ty + ri(tht / 2) - 1, tw - 6, 2).fill({ color: p.pingPongLine, alpha: 0.7 });
  // Center net & posts.
  const midX = tx + ri(tw / 2);
  g.rect(midX - 1, ty - 2, 3, tht + 4).fill(p.pingPongLine);
  g.rect(midX - 2, ty - 3, 5, 3).fill(p.metalDark);
  g.rect(midX - 2, ty + tht, 5, 3).fill(p.metalDark);
  // Two paddles & ball.
  g.circle(tx + 17, ty + 16, 5).fill(0xb8443e);
  g.rect(tx + 10, ty + 18, 4, 2).fill(p.woodTop);
  g.circle(tx + tw - 17, ty + tht - 16, 5).fill(0x2a2636);
  g.rect(tx + tw - 14, ty + tht - 14, 4, 2).fill(p.woodTop);
  g.circle(tx + ri(tw * 0.64), ty + ri(tht * 0.34), 2).fill(p.paper);

  if (hasExtras) {
    const ax = px + pw - 52;
    const ay = py + 16;
    if (night) softGlow(g, ax + 14, ay + 16, 36, 0x7fd1ff, 0.28);
    g.roundRect(ax + 2, ay + 3, 28, 36, 3).fill({ color: 0x000000, alpha: 0.2 });
    g.roundRect(ax, ay, 28, 36, 3).fill(night ? 0x453061 : 0x573c75);
    g.rect(ax + 3, ay + 3, 22, 5).fill(0xd4a03b);
    g.rect(ax + 4, ay + 10, 20, 14).fill(0x162038);
    g.rect(ax + 7, ay + 13, 3, 2).fill(0x5eb87a);
    g.rect(ax + 12, ay + 13, 3, 2).fill(0x5eb87a);
    g.rect(ax + 17, ay + 13, 3, 2).fill(0x5eb87a);
    g.rect(ax + 12, ay + 20, 4, 2).fill(0x69b5db);
    g.rect(ax + 3, ay + 25, 22, 6).fill(0x2a2438);
    g.circle(ax + 8, ay + 28, 2).fill(0xc4453d);
    g.rect(ax + 15, ay + 27, 2, 2).fill(0xd9a33f);
    g.rect(ax + 19, ay + 27, 2, 2).fill(0x5eb87a);
    if (ph >= 110) drawPlant(g, px + pw - 36, py + ph - 42, p);
  } else {
    drawPlant(g, px + 8, py + 8, p, true);
  }
}

function drawLoungeNook(g: Graphics, z: FloorZone, p: Palette, night: boolean): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  const rugCol = p.rugs[z.seed % p.rugs.length]!;
  const sofaCol = p.rugs[(z.seed + 2) % p.rugs.length]!;

  // Woven area rug using nested solid rounded rects (smooth at any zoom).
  g.roundRect(px + 8, py + 8, pw - 16, ph - 16, 8).fill({ color: rugCol, alpha: night ? 0.72 : 0.78 });
  g.roundRect(px + 13, py + 13, pw - 26, ph - 26, 6).fill({ color: 0xfdfaf3, alpha: night ? 0.08 : 0.14 });
  g.roundRect(px + 15, py + 15, pw - 30, ph - 30, 5).fill({ color: rugCol, alpha: night ? 0.72 : 0.78 });

  // Grand lounge layout for spacious rooms (>= 6x6 tiles).
  if (pw >= 180 && ph >= 180) {
    const shelfW = Math.min(110, pw - 68);
    drawBookshelf(g, px + 18, py + 14, shelfW, 24, p, night);
    drawFloorLamp(g, px + pw - 26, py + 38, night);

    const mainSofaW = Math.min(96, pw - 84);
    const mainX = px + ri((pw - mainSofaW) / 2);
    const mainY = py + 58;
    drawSofa(g, mainX, mainY, mainSofaW, 26, sofaCol, p.pillow);

    const sideSofaH = Math.min(82, ph - 140);
    drawSofa(g, px + 18, mainY + 34, 24, sideSofaH, sofaCol, p.pillow);

    const ctw = ri(Math.min(68, mainSofaW * 0.8));
    const cth = 32;
    const ctx = mainX + ri((mainSofaW - ctw) / 2) + 8;
    const cty = mainY + 44;
    g.roundRect(ctx + 2, cty + 3, ctw, cth, 5).fill({ color: 0x000000, alpha: 0.18 });
    g.roundRect(ctx, cty, ctw, cth, 5).fill(p.woodDark);
    g.roundRect(ctx + 2, cty + 2, ctw - 4, cth - 4, 4).fill(p.woodTop);
    g.rect(ctx + 8, cty + 6, 14, 10).fill(p.paper);
    g.rect(ctx + 15, cty + 6, 2, 10).fill(p.metalDark);
    g.rect(ctx + ctw - 16, cty + 7, 7, 7).fill(p.rugs[0]!);
    g.rect(ctx + ctw - 26, cty + 17, 6, 6).fill(p.paper);
    g.circle(ctx + 28, cty + 21, 5).fill(p.leaves[1]);

    const armCol = p.rugs[(z.seed + 4) % p.rugs.length]!;
    drawSofa(g, mainX + mainSofaW - 36, Math.min(py + ph - 48, cty + cth + 18), 36, 28, armCol, p.pillow);
    drawPlant(g, px + 16, py + ph - 44, p);
    drawPlant(g, px + pw - 38, py + ph - 44, p);
    return;
  }

  if (pw >= ph) {
    const sofaW = Math.min(76, pw - 42);
    const sx = px + ri((pw - sofaW) / 2);
    const sy = py + 14;
    drawSofa(g, sx, sy, sofaW, 24, sofaCol, p.pillow);
    const tw = ri(Math.min(48, sofaW * 0.72));
    const tx = px + ri((pw - tw) / 2);
    const ty = Math.min(py + ph - 32, sy + 32);
    g.roundRect(tx + 2, ty + 3, tw, 18, 4).fill({ color: 0x000000, alpha: 0.16 });
    g.roundRect(tx, ty, tw, 18, 4).fill(p.woodDark);
    g.roundRect(tx + 2, ty + 2, tw - 4, 14, 3).fill(p.woodTop);
    g.rect(tx + 6, ty + 4, 10, 8).fill(p.paper);
    g.rect(tx + tw - 12, ty + 5, 6, 6).fill(p.rugs[0]!);
    drawFloorLamp(g, px + pw - 20, py + 32, night);
    drawPlant(g, px + 10, py + ph - 36, p, true);
  } else {
    const sofaH = Math.min(82, ph - 42);
    const sx = px + 14;
    const sy = py + ri((ph - sofaH) / 2);
    drawSofa(g, sx, sy, 24, sofaH, sofaCol, p.pillow);
    const tht = ri(Math.min(50, sofaH * 0.72));
    const tx = Math.min(px + pw - 32, sx + 32);
    const ty = py + ri((ph - tht) / 2);
    g.roundRect(tx + 2, ty + 3, 18, tht, 4).fill({ color: 0x000000, alpha: 0.16 });
    g.roundRect(tx, ty, 18, tht, 4).fill(p.woodDark);
    g.roundRect(tx + 2, ty + 2, 14, tht - 4, 3).fill(p.woodTop);
    g.rect(tx + 4, ty + 6, 9, 10).fill(p.paper);
    drawFloorLamp(g, px + pw - 18, py + 32, night);
    drawPlant(g, px + pw - 30, py + ph - 36, p, true);
    if (ph >= 170) drawBookshelf(g, px + 12, py + 12, Math.min(pw - 36, 56), 20, p, night);
  }
}

function drawCollabBay(g: Graphics, z: FloorZone, p: Palette, night: boolean): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  const rugCol = p.rugs[(z.seed + 1) % p.rugs.length]!;
  drawAlcovePad(g, px, py, pw, ph, p, 6);
  g.circle(px + ri(pw / 2), py + ri(ph / 2) + 6, ri(Math.min(pw, ph) * 0.36)).fill({ color: rugCol, alpha: night ? 0.55 : 0.65 });

  const shelfW = Math.min(64, pw - 24);
  drawBookshelf(g, px + ri((pw - shelfW) / 2), py + 8, shelfW, 22, p, night);

  const cx = px + ri(pw / 2);
  const cy = py + ri(ph * 0.62);
  const r = ri(Math.min(18, Math.min(pw, ph) * 0.2));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.circle(ri(cx + Math.cos(a) * (r + 8)), ri(cy + Math.sin(a) * (r + 8)), 6).fill(p.stools[i]!);
  }
  g.ellipse(cx, cy + 5, r, ri(r * 0.85)).fill({ color: 0x000000, alpha: 0.18 });
  g.circle(cx, cy, r).fill(p.woodDark);
  g.circle(cx, cy, Math.max(4, r - 2)).fill(p.woodTop);
  g.rect(cx - 8, cy - 5, 10, 7).fill(0x2d3247);
  g.rect(cx - 7, cy - 4, 8, 5).fill(0x6cb5db);
  g.rect(cx + 3, cy + 1, 6, 7).fill(p.paper);

  if (pw >= 110) drawPlant(g, px + 8, py + ph - 34, p, true);
}

function drawBenchNook(g: Graphics, z: FloorZone, p: Palette): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  drawAlcovePad(g, px, py, pw, ph, p, 4);
  const cushion = p.rugs[z.seed % p.rugs.length]!;
  if (pw >= ph) {
    const bw = Math.min(78, Math.max(42, pw - 44));
    const bx = px + ri((pw - bw) / 2);
    const by = py + ri((ph - 20) / 2);
    drawBench(g, bx, by, bw, 20, false, p, cushion);
    if (bx - px >= 22) drawPlant(g, px + 6, py + ri((ph - 24) / 2), p, true);
    if (px + pw - (bx + bw) >= 24) drawPlant(g, px + pw - 26, py + ri((ph - 24) / 2), p, true);
  } else {
    const bh = Math.min(78, Math.max(42, ph - 44));
    const bx = px + ri((pw - 20) / 2);
    const by = py + ri((ph - bh) / 2);
    drawBench(g, bx, by, 20, bh, true, p, cushion);
    if (by - py >= 24) drawPlant(g, px + ri((pw - 18) / 2), py + 6, p, true);
    if (py + ph - (by + bh) >= 26) drawPlant(g, px + ri((pw - 18) / 2), py + ph - 28, p, true);
  }
}

function drawRefreshments(g: Graphics, z: FloorZone, p: Palette, night: boolean): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  drawAlcovePad(g, px, py, pw, ph, p, 4);
  if (pw >= 84) {
    const cx = px + ri(pw / 2);
    const cy = py + ri((ph - 38) / 2);
    drawVending(g, cx - 32, cy, p, night);
    drawWatercooler(g, cx + 6, cy + 2, p);
    if (pw >= 120) drawPlant(g, px + 8, py + ri((ph - 24) / 2), p, true);
  } else if (ph >= 84) {
    const startY = ph >= 150 ? py + 16 : py + 10;
    drawVending(g, px + ri((pw - 28) / 2), startY, p, night);
    drawWatercooler(g, px + ri((pw - 22) / 2), startY + 46, p);
    if (ph >= 150) {
      drawRecyclingBins(g, px + ri((pw - 24) / 2), startY + 92, night);
      drawPlant(g, px + ri((pw - 24) / 2), py + ph - 40, p);
    }
  } else {
    if (z.seed % 2 === 0) {
      drawVending(g, px + 8, py + ri((ph - 38) / 2), p, night);
      drawPlant(g, px + 38, py + ri((ph - 24) / 2), p, true);
    } else {
      drawWatercooler(g, px + 10, py + ri((ph - 34) / 2), p);
      drawPlant(g, px + 36, py + ri((ph - 24) / 2), p, true);
    }
  }
}

function drawPrintStation(g: Graphics, z: FloorZone, p: Palette, night: boolean): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  drawAlcovePad(g, px, py, pw, ph, p, 4);
  if (pw >= 88) {
    const cy = py + ri((ph - 34) / 2);
    drawCopier(g, px + 10, cy, p, night);
    drawRecyclingBins(g, px + 56, cy + 16, night);
    for (let i = 0; i < 3; i++) {
      g.rect(px + 58, cy + 2 + i * 4, 16, 3).fill(p.paper);
      g.rect(px + 58, cy + 5 + i * 4, 16, 1).fill({ color: p.metalDark, alpha: 0.45 });
    }
    if (pw >= 120) drawBookshelf(g, px + pw - 34, py + 10, 26, ph - 20, p, night);
  } else if (ph >= 88) {
    drawCopier(g, px + ri((pw - 38) / 2), py + 10, p, night);
    drawRecyclingBins(g, px + ri((pw - 24) / 2), py + ph - 26, night);
  } else {
    drawCopier(g, px + ri((pw - 38) / 2), py + ri((ph - 34) / 2), p, night);
  }
}

function drawPlanterStrip(g: Graphics, z: FloorZone, p: Palette, night: boolean): void {
  const px = z.x * TILE;
  const py = z.y * TILE;
  const pw = z.w * TILE;
  const ph = z.h * TILE;

  if (z.w >= 2 && z.h >= 2) {
    drawAlcovePad(g, px, py, pw, ph, p, 4);
    if (z.seed % 2 === 0) {
      drawBookshelf(g, px + 8, py + 8, pw - 16, 22, p, night);
      drawPlant(g, px + 10, py + ph - 30, p, true);
      drawFloorLamp(g, px + pw - 18, py + ph - 12, night);
    } else {
      g.roundRect(px + 10, py + 10, pw - 20, ph - 20, 6).fill(p.wood);
      g.roundRect(px + 14, py + 14, pw - 28, ph - 28, 4).fill(night ? 0x262129 : 0x4d3b2f);
      drawTree(g, px + ri(pw / 2), py + ri(ph / 2) - 4, p, 13);
    }
    return;
  }

  // Sleek wood-framed architectural planter box with chunky smooth foliage.
  const pad = 5;
  const bx = px + pad;
  const by = py + pad;
  const bw = pw - pad * 2;
  const bh = ph - pad * 2;
  g.roundRect(bx + 1, by + 2, bw, bh, 4).fill({ color: 0x000000, alpha: 0.16 });
  g.roundRect(bx, by, bw, bh, 4).fill(p.wood);
  g.roundRect(bx + 3, by + 3, Math.max(4, bw - 6), Math.max(4, bh - 6), 2).fill(night ? 0x262129 : 0x4d3b2f);

  const blossoms = [0xd4b47d, 0xc26e57, 0xd9d4c7];
  if (pw >= ph) {
    for (let x = bx + 11, i = 0; x < bx + bw - 7; x += 15, i++) {
      const r = 6 + ((z.seed + i) % 3);
      g.circle(x, by + ri(bh / 2) - 1, r).fill(p.leaves[i % 3]!);
      g.circle(x + 3, by + ri(bh / 2) - 3, Math.max(3, r - 2)).fill(p.leaves[(i + 1) % 3]!);
      if ((z.seed + i) % 4 === 0) g.circle(x - 1, by + ri(bh / 2) - 2, 2).fill(blossoms[(z.seed + i) % blossoms.length]!);
    }
  } else {
    for (let y = by + 11, i = 0; y < by + bh - 7; y += 15, i++) {
      const r = 6 + ((z.seed + i) % 3);
      g.circle(bx + ri(bw / 2), y - 1, r).fill(p.leaves[i % 3]!);
      g.circle(bx + ri(bw / 2) + 2, y - 3, Math.max(3, r - 2)).fill(p.leaves[(i + 1) % 3]!);
      if ((z.seed + i) % 4 === 0) g.circle(bx + ri(bw / 2) - 1, y - 2, 2).fill(blossoms[(z.seed + i) % blossoms.length]!);
    }
  }
}

export function drawFloorBase(floor: Floor, plan: FloorPlan, th: HallwayTheme): Container {
  const container = new PIXI.Container();
  const g = new PIXI.Graphics();
  const p = makePalette(th);
  const W = floor.width * TILE;
  const H = floor.height * TILE;

  // 1. Exterior building drop shadow & calm warm-stone tile base.
  g.roundRect(-6, -4, W + 12, H + 14, 6).fill({ color: 0x000000, alpha: th.night ? 0.45 : 0.3 });
  g.rect(0, 0, W, H).fill(p.stoneA);

  // Subtle two-tone stone pavers with whisper-soft grout (matching office.ts's
  // low-alpha wood planks so zoomed-out views stay smooth and alias-free).
  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (plan.grid[y]![x] === 'room') continue;
      const tx = x * TILE;
      const ty = y * TILE;
      if ((x + y) % 2 === 1) g.rect(tx, ty, TILE, TILE).fill(p.stoneB);
      g.rect(tx, ty, TILE, 1).fill({ color: p.grout, alpha: 0.16 });
      g.rect(tx, ty, 1, TILE).fill({ color: p.grout, alpha: 0.14 });
    }
  }

  // 2. Continuous woven carpet runner along main walking lanes & spine.
  const margin = 5;
  const span = TILE - margin * 2;
  const hasRunner = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < plan.width && y < plan.height && plan.runner[y]![x] === true;

  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (!hasRunner(x, y)) continue;
      const tx = x * TILE;
      const ty = y * TILE;
      const n = hasRunner(x, y - 1);
      const s = hasRunner(x, y + 1);
      const w = hasRunner(x - 1, y);
      const e = hasRunner(x + 1, y);

      const rx = tx + (w ? 0 : margin);
      const ry = ty + (n ? 0 : margin);
      const rw = span + (w ? margin : 0) + (e ? margin : 0);
      const rh = span + (n ? margin : 0) + (s ? margin : 0);
      g.rect(rx, ry, rw, rh).fill(p.runner);

      // Soft wide weave bands (4px, low alpha — smooth at all zoom levels).
      if (w || e) {
        g.rect(tx + 8, ty + margin + 5, 4, span - 10).fill({ color: p.runnerShade, alpha: 0.32 });
        g.rect(tx + 22, ty + margin + 5, 4, span - 10).fill({ color: p.runnerShade, alpha: 0.32 });
      } else {
        g.rect(tx + margin + 5, ty + 8, span - 10, 4).fill({ color: p.runnerShade, alpha: 0.32 });
        g.rect(tx + margin + 5, ty + 22, span - 10, 4).fill({ color: p.runnerShade, alpha: 0.32 });
      }

      // Clean integer 2px carpet trim along unconnected edges.
      if (!n) g.rect(rx + (w ? 0 : 3), ty + margin + 2, rw - (w ? 0 : 3) - (e ? 0 : 3), 2).fill({ color: p.runnerTrim, alpha: 0.52 });
      if (!s) g.rect(rx + (w ? 0 : 3), ty + TILE - margin - 4, rw - (w ? 0 : 3) - (e ? 0 : 3), 2).fill({ color: p.runnerTrim, alpha: 0.52 });
      if (!w) g.rect(tx + margin + 2, ry + (n ? 0 : 3), 2, rh - (n ? 0 : 3) - (s ? 0 : 3)).fill({ color: p.runnerTrim, alpha: 0.52 });
      if (!e) g.rect(tx + TILE - margin - 4, ry + (n ? 0 : 3), 2, rh - (n ? 0 : 3) - (s ? 0 : 3)).fill({ color: p.runnerTrim, alpha: 0.52 });
    }
  }

  // 3. Procedural common zones filling all non-walkway deadzones.
  for (const z of plan.zones) {
    switch (z.kind) {
      case 'atrium':
        drawAtrium(g, z, p, th.night);
        break;
      case 'recreation':
        drawRecreation(g, z, p, th.night);
        break;
      case 'lounge_nook':
        drawLoungeNook(g, z, p, th.night);
        break;
      case 'collab_bay':
        drawCollabBay(g, z, p, th.night);
        break;
      case 'bench_nook':
        drawBenchNook(g, z, p);
        break;
      case 'refreshments':
        drawRefreshments(g, z, p, th.night);
        break;
      case 'print_station':
        drawPrintStation(g, z, p, th.night);
        break;
      case 'planter_strip':
        drawPlanterStrip(g, z, p, th.night);
        break;
    }
  }

  // 4. Soft 2.5D cast shadows under every room's south and east walls.
  for (const r of floor.rooms) {
    const rx = r.x * TILE;
    const ry = r.y * TILE;
    const rw = r.w * TILE;
    const rh = r.h * TILE;
    g.rect(rx + 4, ry + rh, rw, 6).fill({ color: 0x000000, alpha: th.night ? 0.28 : 0.2 });
    g.rect(rx + rw, ry + 4, 5, rh + 2).fill({ color: 0x000000, alpha: th.night ? 0.24 : 0.16 });
  }

  // 5. Doormats centered outside each room's doorway (nested solid fills).
  for (const d of plan.doorways) {
    const mx = ri(d.x * TILE - 14);
    const my = d.y * TILE + 3;
    g.roundRect(mx, my, 28, 11, 2).fill(p.mat);
    g.roundRect(mx + 3, my + 2, 22, 7, 1).fill({ color: p.matTrim, alpha: 0.35 });
    g.roundRect(mx + 5, my + 4, 18, 3, 1).fill(p.mat);
  }

  // 6. Crisp exterior building perimeter frame & front entry vestibule.
  const doorX = floor.door.x * TILE;
  const doorW = TILE * 2;
  const wallT = 6;
  g.rect(0, 0, Math.max(0, doorX), wallT).fill(p.shellWall);
  g.rect(doorX + doorW, 0, Math.max(0, W - (doorX + doorW)), wallT).fill(p.shellWall);
  g.rect(0, wallT, W, 2).fill({ color: p.shellTrim, alpha: 0.45 });
  g.rect(0, 0, wallT, H).fill(p.shellWall);
  g.rect(W - wallT, 0, wallT, H).fill(p.shellWall);
  g.rect(0, H - wallT, W, wallT).fill(p.shellWall);

  // Front entrance: brass double doors, welcome mat & flanking plants.
  g.rect(doorX - 3, 0, doorW + 6, 8).fill(0xb88225);
  g.rect(doorX, 1, doorW, 6).fill(0xd9a13b);
  g.rect(doorX + ri(doorW / 2) - 1, 1, 2, 6).fill(p.shellWall);
  g.roundRect(doorX + 6, 10, doorW - 12, 13, 3).fill(p.mat);
  g.roundRect(doorX + 9, 12, doorW - 18, 9, 2).fill({ color: p.matTrim, alpha: 0.4 });
  g.roundRect(doorX + 11, 14, doorW - 22, 5, 1).fill(p.mat);
  if (doorX - 24 > wallT) drawPlant(g, doorX - 24, 4, p, true);
  if (doorX + doorW + 24 < W - wallT) drawPlant(g, doorX + doorW + 6, 4, p, true);

  // 7. Nighttime recessed hallway downlights along main corridors.
  if (th.night) {
    for (let y = 0; y < plan.height; y++) {
      for (let x = 0; x < plan.width; x++) {
        if (!hasRunner(x, y)) continue;
        const isJunction = hasRunner(x, y - 1) || hasRunner(x, y + 1);
        if ((x === 0 && isJunction && y % 6 === 0) || (x > 0 && x % 8 === 4 && !isJunction)) {
          softGlow(g, x * TILE + TILE / 2, y * TILE + TILE / 2, 42, 0xffd36b, 0.14);
        }
      }
    }
    softGlow(g, doorX + doorW / 2, 16, 48, 0xffd36b, 0.24);
  }

  container.addChild(g);
  return container;
}
