/// <reference path="./pixi-global.d.ts" />
// Drawing a room's flair (the kit: flair-kit.ts): the animated pixel emblem in a small frame on the
// room's wall side, its motto plaque, and one ambient effect, all quiet and looping. Room-local
// coordinates; the room's container holds it above the floor and below the people.

import { EMBLEM_SIZE, type Flair } from './flair-kit.ts';

type Container = import('pixi.js').Container;
type Graphics = import('pixi.js').Graphics;

const PX = 2; // screen pixels per emblem pixel
const FRAME = EMBLEM_SIZE * PX + 8;
const hex = (c: string) => parseInt(c.slice(1), 16);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Where the emblem hangs: the right of the room under the wall band, else the left; none when both
// would cover something already there (hand-placed decor, the poster).
export function emblemSpot(w: number, h: number, wallH: number, avoid: Rect[]): Rect | undefined {
  const y = wallH + 6;
  if (y + FRAME + 14 > h - 50) return undefined; // too short a room: the lead stands there
  for (const x of [w - FRAME - 12, 12]) {
    const r = { x, y, w: FRAME, h: FRAME + 10 };
    if (!avoid.some((a) => hits(a, r))) return r;
  }
  return undefined;
}

export interface FlairArt {
  c: Container;
  tick(dt: number, t: number): void;
}

export function drawFlair(f: Flair, room: { w: number; h: number; wallH: number; seed: number; night: boolean; avoid: Rect[] }): FlairArt | undefined {
  const spot = emblemSpot(room.w, room.h, room.wallH, room.avoid);
  if (!spot) return undefined;
  const c = new PIXI.Container();
  c.eventMode = 'none';
  const cx = spot.x + FRAME / 2;
  const cy = spot.y + FRAME / 2;
  const colour = f.ambient ? hex(f.ambient.colour) : 0xffffff;

  // Behind the frame: the pulse's glow.
  const back = new PIXI.Graphics();
  c.addChild(back);
  const frame = new PIXI.Graphics();
  frame.rect(spot.x + 2, spot.y + 3, FRAME, FRAME).fill({ color: 0x000000, alpha: 0.18 }); // shadow
  frame.rect(spot.x, spot.y, FRAME, FRAME).fill(0x4a3a2c);
  frame.rect(spot.x + 2, spot.y + 2, FRAME - 4, FRAME - 4).fill(room.night ? 0x2a2f45 : 0xfbf7ee);
  c.addChild(frame);
  const frames: Graphics[] = f.emblem.frames.map((rows) => {
    const g = new PIXI.Graphics();
    rows.forEach((row, j) =>
      [...row].forEach((ch, i) => {
        const col = f.emblem.palette[ch];
        if (col) g.rect(spot.x + 4 + i * PX, spot.y + 4 + j * PX, PX, PX).fill(hex(col));
      }),
    );
    g.visible = false;
    c.addChild(g);
    return g;
  });
  frames[0]!.visible = true;
  if (f.motto) {
    const t = new PIXI.Text({ text: f.motto, style: { fontFamily: 'ui-rounded, system-ui', fontSize: 7, fontWeight: '800', fill: room.night ? 0xe9e2f0 : 0x5a4a3c, align: 'center' } });
    t.anchor.set(0.5, 0);
    const half = t.width / 2;
    t.position.set(Math.min(room.w - 8 - half, Math.max(8 + half, cx)), spot.y + FRAME + 2);
    c.addChild(t);
  }
  const fx = new PIXI.Graphics();
  c.addChild(fx);

  // A little seeded randomness, so two rooms with the same effect don't move in step.
  let s = room.seed || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const inside = { x: 10, y: room.wallH + 4, w: room.w - 20, h: room.h - room.wallH - 14 };
  const dots = Array.from({ length: 6 }, () => ({ x: inside.x + rnd() * inside.w, y: inside.y + rnd() * inside.h, p: rnd() * Math.PI * 2, v: 0.5 + rnd() }));
  const bits = f.ambient?.kind === 'bits'
    ? [0, 1, 2].map((i) => {
        const t = new PIXI.Text({ text: i % 2 ? '1' : '0', style: { fontFamily: 'ui-monospace, monospace', fontSize: 7, fontWeight: '700', fill: colour } });
        c.addChild(t);
        return t;
      })
    : [];

  let frameAt = 0;
  let shown = 0;
  return {
    c,
    tick(dt, t) {
      frameAt += dt;
      const step = 1000 / f.emblem.fps;
      if (frameAt >= step) {
        frameAt %= step;
        frames[shown]!.visible = false;
        shown = (shown + 1) % frames.length;
        frames[shown]!.visible = true;
      }
      if (!f.ambient) return;
      const sec = t / 1000;
      fx.clear();
      switch (f.ambient.kind) {
        case 'sparkle':
          for (const d of dots) {
            const a = Math.max(0, Math.sin(sec * d.v * 1.6 + d.p)) ** 4;
            if (a > 0.02) fx.rect(d.x - 2, d.y, 5, 1).fill({ color: colour, alpha: a }).rect(d.x, d.y - 2, 1, 5).fill({ color: colour, alpha: a });
          }
          break;
        case 'motes':
          for (const d of dots) {
            const x = inside.x + ((d.x - inside.x + sec * 4 * d.v) % inside.w);
            const y = d.y + Math.sin(sec * 0.7 + d.p) * 5;
            fx.circle(x, y, 1).fill({ color: colour, alpha: 0.35 + 0.25 * Math.sin(sec + d.p) });
          }
          break;
        case 'bubbles':
        case 'steam':
          for (let i = 0; i < 4; i++) {
            const k = (sec * 0.35 + i / 4) % 1;
            const x = cx + Math.sin(k * 7 + i * 2) * (f.ambient.kind === 'steam' ? 4 : 6) + (i - 1.5) * 4;
            const y = spot.y - 2 - k * 26;
            if (f.ambient.kind === 'bubbles') fx.circle(x, y, 1.5 + k).stroke({ color: colour, width: 1, alpha: 1 - k });
            else fx.circle(x, y, 2 + k * 3).fill({ color: colour, alpha: 0.35 * (1 - k) });
          }
          break;
        case 'orbit': {
          const a = sec * 1.4;
          fx.circle(cx + Math.cos(a) * (FRAME / 2 + 5), cy + Math.sin(a) * (FRAME / 2 + 5) * 0.6, 2).fill(colour);
          break;
        }
        case 'pulse':
          back.clear();
          for (let i = 6; i >= 1; i--) back.circle(cx, cy, FRAME / 2 + i * 3).fill({ color: colour, alpha: (0.05 + 0.04 * Math.sin(sec * 1.8)) / 1.5 });
          break;
        case 'blink':
          for (let i = 0; i < 3; i++) {
            const on = Math.floor(sec * 2 + i * 0.7) % 3 === i;
            fx.circle(spot.x - 6, spot.y + 6 + i * 9, 2).fill({ color: on ? colour : 0x3a3346, alpha: on ? 1 : 0.5 });
          }
          break;
        case 'bits':
          bits.forEach((b, i) => {
            const k = (sec * 0.3 + i / 3) % 1;
            b.position.set(cx - 10 + i * 8, spot.y - 4 - k * 24);
            b.alpha = k < 0.2 ? k / 0.2 : 1 - k;
          });
          break;
        case 'leaves':
          dots.slice(0, 3).forEach((d, i) => {
            const k = (sec * 0.06 * d.v + i / 3) % 1;
            const x = d.x + Math.sin(k * 12 + d.p) * 10;
            const y = inside.y + k * inside.h;
            fx.ellipse(x, y, 3, 1.5).fill({ color: colour, alpha: k > 0.85 ? (1 - k) / 0.15 : 0.8 });
          });
          break;
        case 'ripple':
          for (let i = 0; i < 2; i++) {
            const k = (sec * 0.25 + i / 2) % 1;
            fx.ellipse(room.w * 0.25, room.h - 64, 4 + k * 22, 2 + k * 8).stroke({ color: colour, width: 1, alpha: 0.6 * (1 - k) });
          }
          break;
      }
    },
  };
}
