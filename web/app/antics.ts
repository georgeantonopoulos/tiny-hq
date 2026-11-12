// What a happening can show besides its line: a little prop beside the person for a while, and
// a stock move. The names come from the kit in whimsy.ts; Haiku only
// picks them. Everything is drawn here in the office's flat pixel style.

import type { Anim, Prop } from './whimsy.ts';

type Container = import('pixi.js').Container;
type Graphics = import('pixi.js').Graphics;

// A prop, drawn with its bottom-centre at (0, 0), about 20 px tall.
export function drawProp(kind: Prop): Graphics {
  const g = new PIXI.Graphics();
  switch (kind) {
    case 'duck':
      g.ellipse(0, -6, 9, 6).fill(0xf6d743);
      g.circle(5, -14, 5).fill(0xf6d743);
      g.poly([9, -15, 14, -13, 9, -12]).fill(0xf08a24);
      g.rect(6, -16, 2, 2).fill(0x221d28);
      break;
    case 'cake':
      g.rect(-10, -10, 20, 10).fill(0xf3c4d0);
      g.rect(-10, -12, 20, 3).fill(0xfdfaf3);
      g.rect(-1, -19, 2, 7).fill(0x7fd1ff);
      g.ellipse(0, -21, 1.5, 2.5).fill(0xf2b544);
      break;
    case 'balloon':
      g.moveTo(0, 0).bezierCurveTo(-4, -8, 4, -14, 0, -20).stroke({ color: 0x5d5470, width: 1 });
      g.ellipse(0, -28, 7, 9).fill(0xe05a5a);
      g.ellipse(-2, -31, 2, 3).fill({ color: 0xffffff, alpha: 0.5 });
      break;
    case 'cactus':
      g.rect(-6, -6, 12, 6).fill(0xb5654a);
      g.roundRect(-3, -22, 6, 17, 3).fill(0x4f9a5c);
      g.roundRect(-9, -16, 5, 8, 2).fill(0x4f9a5c);
      g.roundRect(4, -19, 5, 8, 2).fill(0x4f9a5c);
      break;
    case 'pizza':
      g.rect(-12, -4, 24, 4).fill(0xd9b98c);
      g.poly([-9, -4, 9, -4, 0, -14]).fill(0xf2c84b);
      g.circle(-2, -7, 1.5).fill(0xc0504d).circle(3, -6, 1.5).fill(0xc0504d).circle(0, -10, 1.5).fill(0xc0504d);
      break;
    case 'mug':
      g.roundRect(-6, -12, 12, 12, 2).fill(0xfdfaf3);
      g.circle(8, -6, 3).stroke({ color: 0xfdfaf3, width: 2 });
      g.rect(-4, -10, 8, 2).fill(0x6b4a2f);
      g.moveTo(-2, -15).lineTo(-1, -19).moveTo(2, -15).lineTo(3, -19).stroke({ color: 0xdfe6ee, width: 1, alpha: 0.8 });
      break;
    case 'trophy':
      g.rect(-5, -4, 10, 4).fill(0x6b4a2f);
      g.rect(-1, -9, 2, 5).fill(0xf2c84b);
      g.poly([-8, -20, 8, -20, 4, -9, -4, -9]).fill(0xf2c84b);
      break;
    case 'discoball':
      g.moveTo(0, -34).lineTo(0, -26).stroke({ color: 0x5d5470, width: 1 });
      g.circle(0, -19, 7).fill(0xc9d3dc);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if ((i + j) % 2 === 0) g.rect(i * 4 - 1.5, -19 + j * 4 - 1.5, 3, 3).fill(0xfdfaf3);
      break;
    case 'banana':
      g.moveTo(-10, -6).bezierCurveTo(-6, 2, 6, 2, 10, -8).stroke({ color: 0xf6d743, width: 5, cap: 'round' });
      g.rect(9, -11, 2, 3).fill(0x6b4a2f);
      break;
    case 'papers':
      for (let i = 0; i < 4; i++) g.rect(-9 + (i % 2), -4 - i * 3, 18, 3).fill(i % 2 ? 0xf4f1ea : 0xfdfaf3).stroke({ color: 0xc9c3b8, width: 0.5 });
      break;
  }
  return g;
}

// A move playing out in the world: `step` gets its progress (0..1) each frame.
export interface Effect {
  c: Container;
  ms: number;
  t: number;
  step(k: number): void;
}

// The world-level moves (spin and hop are the person's own; see Person.trick).
// (x, y): the person's top-left in world coordinates; sprites are about 36 x 52.
export function effect(kind: Exclude<Anim, 'spin' | 'hop'>, x: number, y: number, rnd: () => number = Math.random): Effect {
  const c = new PIXI.Container();
  const head = { x: x + 18, y: y - 4 };
  switch (kind) {
    case 'plane': {
      const g = new PIXI.Graphics().poly([0, 0, 14, 4, 0, 8, 3, 4]).fill(0xfdfaf3).poly([3, 4, 14, 4, 4, 7]).fill(0xdfe6ee);
      c.addChild(g);
      const dir = rnd() < 0.5 ? -1 : 1;
      g.scale.x = dir;
      return { c, ms: 2600, t: 0, step: (k) => {
        g.position.set(head.x + dir * k * 220, head.y + 10 - k * 60 + Math.sin(k * 9) * 6);
        g.alpha = k > 0.85 ? (1 - k) / 0.15 : 1;
      } };
    }
    case 'cat': {
      const g = new PIXI.Graphics();
      g.roundRect(0, 4, 16, 8, 3).fill(0x3a3346); // body
      g.circle(17, 4, 5).fill(0x3a3346); // head
      g.poly([13, 1, 15, -4, 17, 0]).fill(0x3a3346).poly([18, 0, 20, -4, 22, 1]).fill(0x3a3346);
      g.moveTo(0, 6).bezierCurveTo(-6, 4, -6, -4, -2, -6).stroke({ color: 0x3a3346, width: 2 });
      g.rect(18, 3, 1.5, 1.5).fill(0xf2c84b);
      c.addChild(g);
      const legs = new PIXI.Graphics();
      c.addChild(legs);
      const from = x - 120;
      return { c, ms: 6500, t: 0, step: (k) => {
        const px = from + k * 280;
        const py = y + 58;
        g.position.set(px, py);
        const s = Math.floor(k * 40) % 2;
        legs.clear().rect(px + 2 + s * 2, py + 11, 2, 4).fill(0x3a3346).rect(px + 12 - s * 2, py + 11, 2, 4).fill(0x3a3346);
        c.alpha = k < 0.08 ? k / 0.08 : k > 0.92 ? (1 - k) / 0.08 : 1;
      } };
    }
    case 'confetti': {
      const colours = [0xe05a5a, 0xf2b544, 0x7fd1ff, 0x81b29a, 0xc58ae0];
      const bits = Array.from({ length: 18 }, (_, i) => {
        const g = new PIXI.Graphics().rect(-2, -1, 4, 2).fill(colours[i % colours.length]!);
        c.addChild(g);
        const a = -Math.PI / 2 + (rnd() - 0.5) * 2.2;
        return { g, vx: Math.cos(a) * (60 + rnd() * 60), vy: Math.sin(a) * (90 + rnd() * 60), spin: (rnd() - 0.5) * 12 };
      });
      return { c, ms: 1600, t: 0, step: (k) => {
        const s = k * 1.6;
        for (const b of bits) {
          b.g.position.set(head.x + b.vx * s, head.y + b.vy * s + 140 * s * s);
          b.g.rotation = b.spin * s;
        }
        c.alpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      } };
    }
    case 'zzz':
    case 'notes': {
      const glyphs = kind === 'zzz' ? ['z', 'z', 'Z'] : ['♪', '♫', '♪'];
      const ts = glyphs.map((txt, i) => {
        const t = new PIXI.Text({ text: txt, style: { fontFamily: 'ui-rounded, system-ui', fontSize: 9 + i * 2, fontWeight: '700', fill: kind === 'zzz' ? 0x7fa7d9 : 0xc58ae0 } });
        c.addChild(t);
        return t;
      });
      return { c, ms: 3200, t: 0, step: (k) => {
        ts.forEach((t, i) => {
          const local = Math.min(1, Math.max(0, k * 1.6 - i * 0.25));
          t.position.set(head.x + 10 + i * 6 + Math.sin(local * 6 + i) * 4, head.y - 4 - local * 30);
          t.alpha = local <= 0 ? 0 : local > 0.75 ? (1 - local) / 0.25 : 1;
        });
      } };
    }
    case 'rain': {
      const cloud = new PIXI.Graphics().circle(-8, 0, 6).fill(0x9b93a6).circle(0, -3, 8).fill(0x9b93a6).circle(8, 0, 6).fill(0x9b93a6).rect(-8, 0, 16, 5).fill(0x9b93a6);
      const drops = new PIXI.Graphics();
      c.addChild(drops, cloud);
      cloud.position.set(head.x, head.y - 18);
      return { c, ms: 3600, t: 0, step: (k) => {
        drops.clear();
        for (let i = 0; i < 5; i++) {
          const f = (k * 9 + i * 0.37) % 1;
          drops.rect(head.x - 10 + i * 5, head.y - 12 + f * 22, 1, 3).fill({ color: 0x7fd1ff, alpha: 1 - f });
        }
        c.alpha = k < 0.1 ? k / 0.1 : k > 0.85 ? (1 - k) / 0.15 : 1;
      } };
    }
  }
}
