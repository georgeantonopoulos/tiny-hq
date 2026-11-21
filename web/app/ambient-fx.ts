// The Tiny HQ sign over the front door, and the drawing for the little scenes around the
// building (which scene and when: ambience.ts). Flat pixel style like the rest of the office.

import type { Effect } from './antics.ts';
import { corridorRows, signWord, wander, type Scene } from './ambience.ts';
import type { FloorPlan, FloorZone } from './floorplan.ts';

type Container = import('pixi.js').Container;
type Graphics = import('pixi.js').Graphics;
type Text = import('pixi.js').Text;

const TILE = 32;
// The sign is drawn at its own size, then scaled up so it reads on a tall floor.
const SIGN_SCALE = 1.7;
const SIGN_TOP = -98; // the board's top before scaling, from the front wall
// Room left outside the building's front wall for the pavement, the sign and the sky above it.
export const OUTSIDE = Math.ceil(-SIGN_TOP * SIGN_SCALE) + 14;

const GOLD = 0xf2c84b;
const CREAM = 0xfdf3d8;
const NAVY = 0x1f2747;

export interface Sign {
  c: Container;
  perch: { x: number; y: number }; // where a pigeon stands: the middle of the sign's top edge
  tick(dt: number, t: number): void;
  flicker(): void;
  destroy(): void; // frees the halo's blur filter, which destroying the container leaves behind
}

// The pavement in front of the building and the sign over the door. `W`: the building's width;
// `doorCx`: the middle of the front door, in world pixels.
export function drawSign(W: number, doorCx: number, night: boolean, name = 'Tiny HQ'): Sign {
  const c = new PIXI.Container();
  const ground = new PIXI.Graphics();
  // Pavement: slabs along the front wall, a kerb, and a path up to the door.
  const paveTop = -30;
  ground.rect(-16, paveTop, W + 32, 30).fill(night ? 0x2a2838 : 0x6f6676);
  for (let x = -16; x < W + 16; x += 28) ground.rect(x, paveTop, 1, 30).fill({ color: 0x000000, alpha: 0.18 });
  ground.rect(-16, paveTop + 14, W + 32, 1).fill({ color: 0x000000, alpha: 0.12 });
  ground.rect(-16, paveTop - 4, W + 32, 4).fill(night ? 0x3a3850 : 0x9b93a6);
  ground.rect(doorCx - 30, paveTop, 60, 30).fill(night ? 0x3b3045 : 0x9a7f6a);
  for (let y = paveTop + 4; y < 0; y += 8) ground.rect(doorCx - 28, y, 56, 1).fill({ color: 0x000000, alpha: 0.15 });
  c.addChild(ground);

  // The sign: a navy board in a gold frame, standing on two posts either side of the path.
  const bw = 236;
  const bh = 52;
  const bx = doorCx - bw / 2;
  const by = SIGN_TOP;
  const sc = new PIXI.Container(); // the sign itself, scaled about the middle of the door
  sc.pivot.set(doorCx, 0);
  sc.position.set(doorCx, 0);
  sc.scale.set(SIGN_SCALE);
  c.addChild(sc);
  const posts = new PIXI.Graphics();
  for (const px of [doorCx - 46, doorCx + 42]) {
    posts.rect(px, by + bh - 4, 4, -by - bh + 2).fill(0x3a3346);
    posts.rect(px + 1, by + bh - 4, 1, -by - bh + 2).fill({ color: 0xffffff, alpha: 0.15 });
  }
  sc.addChild(posts);

  const glow = new PIXI.Graphics();
  for (let i = 10; i >= 1; i--) glow.roundRect(bx - i * 3, by - i * 3, bw + i * 6, bh + i * 6, 10 + i * 3).fill({ color: 0xffc966, alpha: 0.022 });
  sc.addChild(glow);

  const board = new PIXI.Graphics();
  board.roundRect(bx + 3, by + 4, bw, bh, 8).fill({ color: 0x000000, alpha: 0.35 }); // shadow
  board.roundRect(bx, by, bw, bh, 8).fill(0xb88225);
  board.roundRect(bx + 3, by + 3, bw - 6, bh - 6, 6).fill(NAVY);
  board.roundRect(bx + 6, by + 6, bw - 12, bh - 12, 4).stroke({ color: GOLD, width: 1, alpha: 0.55 });
  // Bulbs along the frame, like a theatre sign.
  const bulbs: { x: number; y: number }[] = [];
  for (let x = bx + 14; x <= bx + bw - 14; x += 18) bulbs.push({ x, y: by + 2 }, { x, y: by + bh - 2 });
  sc.addChild(board);
  const bulbG = new PIXI.Graphics();
  sc.addChild(bulbG);

  // The office's name, one letter at a time so a single letter can flicker at night.
  const word = signWord(name);
  const style = { fontFamily: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif', fontSize: 25, fontWeight: '900' as const, fill: CREAM };
  const letters: Text[] = [];
  const halo = new PIXI.Container();
  const front = new PIXI.Container();
  let x = 0;
  for (const ch of word) {
    if (ch === ' ') {
      x += 6;
      continue;
    }
    const h = new PIXI.Text({ text: ch, style: { ...style, fill: 0xffb347 } });
    const t = new PIXI.Text({ text: ch, style });
    h.position.set(x, 0);
    t.position.set(x, 0);
    halo.addChild(h);
    front.addChild(t);
    letters.push(t);
    x += t.width + 3;
  }
  // A long name shrinks to fit inside the frame.
  const fit = Math.min(1, (bw - 28) / Math.max(1, x - 3));
  const textW = (x - 3) * fit;
  const textX = doorCx - textW / 2;
  const textY = by + 6 + (1 - fit) * 12;
  for (const g of [halo, front]) {
    g.scale.set(fit);
    g.position.set(textX, textY);
  }
  const blur = new PIXI.BlurFilter({ strength: 5, quality: 3 });
  halo.filters = [blur];
  halo.alpha = night ? 0.95 : 0.35;
  sc.addChild(halo, front);
  const sub = new PIXI.Text({ text: '★  A ROOM FOR EVERY PROJECT  ★', style: { fontFamily: 'ui-rounded, system-ui, sans-serif', fontSize: 7.5, fontWeight: '800', fill: GOLD, letterSpacing: 1.2 } });
  sub.anchor.set(0.5, 0);
  sub.position.set(doorCx, by + bh - 17);
  sc.addChild(sub);

  // A little lamp on each post.
  const lamps = new PIXI.Graphics();
  for (const lx of [bx - 10, bx + bw + 10]) {
    if (night) for (let i = 8; i >= 1; i--) lamps.circle(lx, by + bh / 2, i * 4).fill({ color: 0xffd36b, alpha: 0.03 });
    lamps.rect(lx - 1, by + bh / 2, 2, -by - bh / 2).fill(0x3a3346);
    lamps.roundRect(lx - 5, by + bh / 2 - 9, 10, 11, 3).fill(0x3a3346);
    lamps.roundRect(lx - 3, by + bh / 2 - 7, 6, 7, 2).fill(night ? 0xffe9a8 : 0xd9cfa0);
  }
  sc.addChild(lamps);

  // A sheen that slides across the board now and then, by day.
  const sheen = new PIXI.Graphics().poly([0, 0, 18, 0, 6, bh, -12, bh]).fill({ color: 0xffffff, alpha: 0.16 });
  const mask = new PIXI.Graphics().roundRect(bx + 3, by + 3, bw - 6, bh - 6, 6).fill(0xffffff);
  sheen.mask = mask;
  sheen.position.set(bx - 40, by);
  sc.addChild(mask, sheen);

  let flick = 0; // ms left of a flicker
  let flickLetter = 0;
  return {
    c,
    perch: { x: doorCx, y: by * SIGN_SCALE },
    destroy() {
      halo.filters = [];
      blur.destroy();
      if (!c.destroyed) c.destroy({ children: true });
    },
    flicker() {
      flick = 1400;
      flickLetter = Math.floor(Math.random() * letters.length);
    },
    tick(dt, t) {
      // Bulbs chase round the frame, slowly.
      bulbG.clear();
      const step = Math.floor(t / 420);
      bulbs.forEach((b, i) => {
        const on = (i >> 1) % 3 !== step % 3;
        bulbG.circle(b.x, b.y, 2).fill(on ? (night ? 0xfff1b8 : 0xf6e2a0) : 0x8a6a3a);
        if (on && night) bulbG.circle(b.x, b.y, 4).fill({ color: 0xffe08a, alpha: 0.25 });
      });
      // The halo breathes; at night it hums like neon.
      const breathe = 0.5 + 0.5 * Math.sin(t / 900);
      halo.alpha = night ? 0.75 + breathe * 0.25 : 0.25 + breathe * 0.15;
      glow.alpha = night ? 0.8 + breathe * 0.2 : 0.35;
      // Sheen: one pass every 9 s.
      const k = (t % 9000) / 1600;
      sheen.visible = k < 1;
      if (k < 1) sheen.x = bx - 30 + k * (bw + 60);
      // A flicker: one letter stutters off and on, its halo with it.
      for (const l of letters) l.alpha = 1;
      if (flick > 0) {
        flick -= dt;
        const off = Math.sin(flick / 37) * Math.sin(flick / 91) > 0.2;
        letters[flickLetter]!.alpha = off ? 0.25 : 1;
        (halo.children[flickLetter] as Container).alpha = off ? 0.1 : 1;
      } else halo.children.forEach((h) => (h.alpha = 1));
    },
  };
}

// What a scene needs to know about the building, in world pixels.
export interface Stage {
  W: number;
  H: number;
  night: boolean;
  plan: FloorPlan;
  sign?: Sign;
  doorCx: number;
}

// Scene sprites are drawn this much bigger than the floor's own pixel art, so they read when
// the whole floor is fitted on screen (about half size).
const Z = 2;

const fade = (k: number, inn = 0.08, out = 0.08) => (k < inn ? k / inn : k > 1 - out ? (1 - k) / out : 1);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => k * k * (3 - 2 * k);

function bird(g: Graphics, x: number, y: number, flap: number, colour: number, s = 1): void {
  const up = Math.sin(flap) * 4 * s;
  g.moveTo(x - 6 * s, y - up).lineTo(x, y).lineTo(x + 6 * s, y - up).stroke({ color: colour, width: 2 * s, cap: 'round', join: 'round' });
}

function gardens(plan: FloorPlan): FloorZone[] {
  return plan.zones.filter((z) => z.kind === 'atrium' || z.kind === 'planter_strip');
}

// Which layer a scene belongs on: 'ground' scenes are on the floor, under the rooms' people;
// 'sky' scenes fly over everything.
export const LAYER: Record<Exclude<Scene, 'neonflicker'>, 'ground' | 'sky'> = {
  birds: 'sky',
  pigeon: 'sky',
  roomba: 'ground',
  drone: 'sky',
  tumbleweed: 'ground',
  butterfly: 'sky',
  shootingstar: 'sky',
  fireflies: 'sky',
  balloon: 'sky',
};

export function scene(kind: Exclude<Scene, 'neonflicker'>, st: Stage, rnd: () => number): Effect | undefined {
  const c = new PIXI.Container();
  switch (kind) {
    case 'birds': {
      // A small flock in a loose V, across the roof.
      const g = new PIXI.Graphics();
      const shadow = new PIXI.Graphics();
      c.addChild(shadow, g);
      const n = 3 + Math.floor(rnd() * 3);
      const dir = rnd() < 0.5 ? 1 : -1;
      const y0 = -OUTSIDE + rnd() * (st.H * 0.6 + OUTSIDE);
      const y1 = y0 + (rnd() - 0.5) * 240;
      const flock = Array.from({ length: n }, (_, i) => ({ dx: -Math.ceil(i / 2) * 16 * Z, dy: (i % 2 ? -1 : 1) * Math.ceil(i / 2) * 11 * Z, ph: rnd() * 6 }));
      const from = dir > 0 ? -80 : st.W + 80;
      const to = dir > 0 ? st.W + 80 : -80;
      return { c, ms: 11000, t: 0, step: (k) => {
        g.clear();
        shadow.clear();
        const hx = lerp(from, to, k);
        const hy = lerp(y0, y1, k);
        for (const b of flock) {
          const x = hx + b.dx * dir;
          const y = hy + b.dy;
          bird(g, x, y, k * 70 + b.ph, st.night ? 0xb8c0d8 : 0x2b2433, Z);
          shadow.ellipse(x + 10 * Z, y + 26 * Z, 4 * Z, 1.5 * Z).fill({ color: 0x000000, alpha: 0.18 });
        }
      } };
    }
    case 'pigeon': {
      // Flies in, lands on the sign, bobs and pecks about, flies off the other way.
      const perch = st.sign?.perch;
      if (!perch) return undefined;
      const g = new PIXI.Graphics();
      c.addChild(g);
      const dir = rnd() < 0.5 ? 1 : -1;
      const spot = { x: perch.x + (rnd() - 0.5) * 200, y: perch.y };
      const start = { x: spot.x - dir * 260, y: spot.y - 120 };
      const end = { x: spot.x + dir * 300, y: spot.y - 160 };
      return { c, ms: 12000, t: 0, step: (k) => {
        g.clear();
        let x: number, y: number, flying: boolean;
        if (k < 0.2) {
          const e = ease(k / 0.2);
          x = lerp(start.x, spot.x, e);
          y = lerp(start.y, spot.y, e);
          flying = true;
        } else if (k < 0.82) {
          const local = (k - 0.2) / 0.62;
          x = spot.x + Math.sin(local * 5) * 10 * dir;
          y = spot.y;
          flying = false;
        } else {
          const e = ease((k - 0.82) / 0.18);
          x = lerp(spot.x, end.x, e);
          y = lerp(spot.y, end.y, e);
          flying = true;
        }
        const face = flying ? dir : Math.cos(((k - 0.2) / 0.62) * 5) >= 0 ? dir : -dir;
        const peck = !flying && Math.sin(k * 120) > 0.6 ? 3 : 0;
        g.position.set(x, y);
        g.scale.set(Z);
        x = 0;
        y = 0;
        g.ellipse(x, y - 6, 7, 5).fill(0x8d93a8); // body
        g.circle(x + 6 * face, y - 11 + peck, 3.5).fill(0x6b7088); // head
        g.circle(x + 7 * face, y - 12 + peck, 0.9).fill(0xf2c84b);
        g.poly([x + 9 * face, y - 11 + peck, x + 12 * face, y - 10 + peck, x + 9 * face, y - 9.5 + peck]).fill(0xe0a07a);
        g.rect(x + 4 * face - 1, y - 9 + peck, 3, 2).fill(0x7fbf9a); // neck sheen
        if (flying) {
          const up = Math.sin(k * 160) * 6;
          g.moveTo(x - 2, y - 8).lineTo(x - 10 * face, y - 8 - up).stroke({ color: 0x6b7088, width: 3, cap: 'round' });
        } else {
          g.ellipse(x - 2 * face, y - 6, 5, 3).fill(0x7a8098); // wing
          g.rect(x - 2, y - 2, 1, 3).fill(0xe0a07a).rect(x + 2, y - 2, 1, 3).fill(0xe0a07a);
        }
        c.alpha = fade(k, 0.05, 0.08);
      } };
    }
    case 'roomba': {
      // The robot vacuum takes itself for a wander down the corridors.
      const path = wander(st.plan.grid, rnd, 26 + Math.floor(rnd() * 14));
      if (path.length < 6) return undefined;
      const trail = new PIXI.Graphics();
      const g = new PIXI.Graphics();
      c.addChild(trail, g);
      const ms = path.length * 650;
      const behind: { x: number; y: number }[] = []; // the last few spots, newest last
      return { c, ms, t: 0, step: (k) => {
        const f = k * (path.length - 1);
        const i = Math.min(path.length - 2, Math.floor(f));
        const a = path[i]!;
        const b = path[i + 1]!;
        const u = f - i;
        const x = (lerp(a.x, b.x, u) + 0.5) * TILE;
        const y = (lerp(a.y, b.y, u) + 0.5) * TILE;
        // A short clean stripe behind it that fades out.
        const last = behind[behind.length - 1];
        if (!last || Math.hypot(last.x - x, last.y - y) > 3) behind.push({ x, y });
        if (behind.length > 18) behind.shift();
        trail.clear();
        behind.forEach((p, n) => trail.circle(p.x, p.y, 11).fill({ color: 0xffffff, alpha: (n / behind.length) * 0.07 }));
        g.clear();
        g.position.set(x, y);
        g.scale.set(Z * 0.8); // a corridor is one tile wide: a little smaller than the rest
        {
        const x = 0;
        const y = 0;
        g.ellipse(x + 1, y + 3, 11, 5).fill({ color: 0x000000, alpha: 0.25 });
        g.circle(x, y, 10).fill(0x4a4f5c);
        g.circle(x, y, 8).fill(0x5d6373);
        g.rect(x - 6, y - 2, 12, 1).fill({ color: 0x000000, alpha: 0.3 });
        g.circle(x, y - 4, 1.6).fill(Math.floor(k * 60) % 2 ? 0x7cf29c : 0x2f7a46);
        const brush = k * 80;
        for (const s of [-1, 1]) g.moveTo(x + s * 8, y + 6).lineTo(x + s * 8 + Math.cos(brush) * 4, y + 6 + Math.sin(brush) * 4).stroke({ color: 0xd8d0c0, width: 1 });
        }
        c.alpha = fade(k, 0.04, 0.04);
      } };
    }
    case 'drone': {
      // A parcel drone drops a box on the front mat and goes; the box waits a while, then is taken in.
      const drop = { x: st.doorCx + (rnd() - 0.5) * 30, y: -10 };
      const parcel = new PIXI.Graphics().rect(-7, -6, 14, 10).fill(0xc79a5e).rect(-7, -6, 14, 2).fill(0xd4a96a).rect(-1, -6, 2, 10).fill(0xa87a44);
      const shadow = new PIXI.Graphics();
      const g = new PIXI.Graphics();
      parcel.scale.set(Z);
      c.addChild(shadow, parcel, g);
      const from = { x: drop.x + (rnd() < 0.5 ? -1 : 1) * 320, y: -OUTSIDE - 60 };
      return { c, ms: 30000, t: 0, step: (k) => {
        const flight = k / 0.3; // the drone's part: the first 30%
        g.clear();
        shadow.clear();
        if (flight < 1) {
          let x: number, y: number, hold: boolean;
          if (flight < 0.4) {
            const e = ease(flight / 0.4);
            x = lerp(from.x, drop.x, e);
            y = lerp(from.y, drop.y - 40, e);
            hold = true;
          } else if (flight < 0.6) {
            x = drop.x;
            y = drop.y - 40 + Math.sin(((flight - 0.4) / 0.2) * Math.PI) * 16;
            hold = flight < 0.5;
          } else {
            const e = ease((flight - 0.6) / 0.4);
            x = lerp(drop.x, 2 * drop.x - from.x, e);
            y = lerp(drop.y - 40, from.y, e);
            hold = false;
          }
          const spin = k * 900;
          g.position.set(x, y);
          g.scale.set(Z);
          const [wx, wy] = [x, y];
          x = 0;
          y = 0;
          g.rect(x - 12, y - 1, 24, 2).fill(0x3a3346);
          g.roundRect(x - 6, y - 4, 12, 8, 3).fill(0xe6e1d6);
          g.circle(x, y, 1.5).fill(Math.floor(k * 80) % 2 ? 0xe05a5a : 0x7a2a2a);
          for (const s of [-1, 1]) g.ellipse(x + s * 12, y - 2, 6 * Math.abs(Math.cos(spin + s)), 1.5).fill({ color: 0x9b93a6, alpha: 0.8 });
          shadow.ellipse(wx, drop.y + 2, 10 * Z, 3 * Z).fill({ color: 0x000000, alpha: 0.2 });
          if (hold) {
            parcel.position.set(wx, wy + 10 * Z);
            g.moveTo(x, y + 4).lineTo(x, y + 10).stroke({ color: 0x3a3346, width: 1 });
          } else parcel.position.set(drop.x, drop.y);
        } else parcel.position.set(drop.x, drop.y);
        parcel.alpha = k > 0.9 ? (1 - k) / 0.1 : 1;
        c.alpha = k < 0.03 ? k / 0.03 : 1;
      } };
    }
    case 'tumbleweed': {
      // Nobody's working: a tumbleweed rolls down the longest corridor.
      const rows = corridorRows(st.plan.grid, 8);
      if (!rows.length) return undefined;
      const row = rows[Math.floor(rnd() * rows.length)]!;
      const g = new PIXI.Graphics();
      const dust = new PIXI.Graphics();
      c.addChild(dust, g);
      const dir = rnd() < 0.5 ? 1 : -1;
      const a = (dir > 0 ? row.x0 : row.x1 + 1) * TILE;
      const b = (dir > 0 ? row.x1 + 1 : row.x0) * TILE;
      const y0 = (row.y + 0.5) * TILE;
      return { c, ms: 9000, t: 0, step: (k) => {
        const x = lerp(a, b, k);
        const hop = Math.abs(Math.sin(k * 22)) * 6;
        g.clear();
        g.ellipse(x, y0 + 7 * Z * 0.8, 8 * Z * 0.8, 2.5 * Z).fill({ color: 0x000000, alpha: 0.2 });
        const r = 7 * Z * 0.8;
        const spin = k * 40 * dir;
        g.circle(x, y0 - hop, r).stroke({ color: 0xb08a55, width: 2.5 });
        for (let i = 0; i < 4; i++) {
          const ang = spin + (i * Math.PI) / 4;
          g.moveTo(x - Math.cos(ang) * r, y0 - hop - Math.sin(ang) * r).lineTo(x + Math.cos(ang) * r, y0 - hop + Math.sin(ang) * r).stroke({ color: 0x9a7444, width: 1.5 });
        }
        if (Math.floor(k * 30) % 3 === 0) dust.circle(x - dir * 14, y0 + 10, 3).fill({ color: 0xc8b89a, alpha: 0.25 });
        dust.alpha = Math.max(0, 1 - k * 0.6);
        c.alpha = fade(k, 0.05, 0.08);
      } };
    }
    case 'butterfly':
    case 'fireflies': {
      const all = gardens(st.plan);
      const roomy = all.filter((z) => z.w * z.h >= 6);
      const zones = roomy.length ? roomy : all;
      if (!zones.length) return undefined;
      const z = zones[Math.floor(rnd() * zones.length)]!;
      const zx = z.x * TILE;
      const zy = z.y * TILE;
      const zw = Math.max(TILE, z.w * TILE);
      const zh = Math.max(TILE, z.h * TILE);
      const g = new PIXI.Graphics();
      c.addChild(g);
      if (kind === 'butterfly') {
        const colour = [0xf6a6b2, 0xf2c84b, 0x7fd1ff, 0xc58ae0][Math.floor(rnd() * 4)]!;
        const p = [rnd() * 6, rnd() * 6, 1 + rnd(), 1.3 + rnd()];
        return { c, ms: 14000, t: 0, step: (k) => {
          const x = zx + zw / 2 + Math.sin(k * 6 * p[2]! + p[0]!) * zw * 0.4;
          const y = zy + zh / 2 + Math.sin(k * 7 * p[3]! + p[1]!) * zh * 0.35 - 6;
          const w = Math.abs(Math.sin(k * 180)) * 6 + 1.5;
          g.clear();
          g.position.set(x, y);
          g.scale.set(Z);
          {
          const x = 0;
          const y = 0;
          g.ellipse(x + 2, y + 14, 4, 1.5).fill({ color: 0x000000, alpha: 0.15 });
          g.ellipse(x - w, y - 1.5, w, 4.5).fill(colour).ellipse(x + w, y - 1.5, w, 4.5).fill(colour);
          g.ellipse(x - w * 0.7, y + 3, w * 0.7, 3).fill(colour).ellipse(x + w * 0.7, y + 3, w * 0.7, 3).fill(colour);
          g.rect(x - 0.75, y - 4, 1.5, 9).fill(0x3a3346);
          }
          c.alpha = fade(k, 0.1, 0.1);
        } };
      }
      const flies = Array.from({ length: 12 + Math.floor(rnd() * 8) }, () => ({ x: rnd(), y: rnd(), p: rnd() * 6, s: 0.5 + rnd() }));
      return { c, ms: 16000, t: 0, step: (k) => {
        g.clear();
        for (const f of flies) {
          const x = zx + (f.x + Math.sin(k * 5 * f.s + f.p) * 0.12) * zw;
          const y = zy + (f.y + Math.cos(k * 4 * f.s + f.p) * 0.12) * zh;
          const on = Math.max(0, Math.sin(k * 30 * f.s + f.p));
          g.circle(x, y, 9 * Z).fill({ color: 0xfff27a, alpha: on * 0.1 });
          g.circle(x, y, 5 * Z).fill({ color: 0xfff27a, alpha: on * 0.22 });
          g.circle(x, y, 2 * Z).fill({ color: 0xfffbe0, alpha: on });
        }
        c.alpha = fade(k, 0.12, 0.12);
      } };
    }
    case 'shootingstar': {
      // Across the night sky above the building.
      const g = new PIXI.Graphics();
      c.addChild(g);
      const x0 = rnd() * st.W;
      const y0 = -OUTSIDE + 4 + rnd() * 40; // in the strip of night between the page's top bar and the roof
      const dir = rnd() < 0.5 ? 1 : -1;
      const len = 360 + rnd() * 300;
      return { c, ms: 1800, t: 0, step: (k) => {
        g.clear();
        const hx = x0 + dir * len * k;
        const hy = y0 + len * 0.28 * k;
        for (let i = 0; i < 16; i++) {
          const back = i * 10;
          g.circle(hx - dir * back, hy - back * 0.28, (2 - i * 0.11) * Z).fill({ color: 0xfff6d8, alpha: (1 - i / 16) * 0.9 });
        }
        c.alpha = fade(k, 0.1, 0.3);
      } };
    }
    case 'balloon': {
      // Someone let go of a balloon: it drifts up and away off the top of the building.
      const g = new PIXI.Graphics();
      c.addChild(g);
      const colour = [0xe05a5a, 0x7fd1ff, 0xf2c84b, 0x81b29a, 0xc58ae0][Math.floor(rnd() * 5)]!;
      const x0 = 40 + rnd() * (st.W - 80);
      const y0 = st.H * (0.4 + rnd() * 0.5);
      const drift = (rnd() - 0.5) * 160;
      return { c, ms: 16000, t: 0, step: (k) => {
        const x = x0 + drift * k + Math.sin(k * 14) * 8;
        const y = lerp(y0, -OUTSIDE - 60, ease(k));
        const s = Z * (1 + k * 0.25); // rising towards us, a touch bigger
        g.clear();
        g.ellipse(x + 14 * s, y + 40 * s, 5 * s, 2 * s).fill({ color: 0x000000, alpha: 0.15 * (1 - k) });
        g.moveTo(x, y + 9 * s).bezierCurveTo(x - 3 * s, y + 16 * s, x + 3 * s, y + 22 * s, x + Math.sin(k * 20) * 3 * s, y + 28 * s).stroke({ color: 0xdfe6ee, width: 1.5 });
        g.ellipse(x, y, 7 * s, 9 * s).fill(colour);
        g.ellipse(x - 2 * s, y - 3 * s, 2 * s, 3 * s).fill({ color: 0xffffff, alpha: 0.45 });
        c.alpha = fade(k, 0.05, 0.12);
      } };
    }
  }
}
