// Drawing the saved decor in rooms. Simple shapes in the office's own
// style; paintings and posters are pixel art.

import type { SceneObject } from '../../src/office/scene.ts';

type Graphics = import('pixi.js').Graphics;

const hex = (c: string | undefined, fallback: number) => (c && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : fallback);

// A shade darker, per channel (never below black).
const darken = (c: number) => (Math.max(0, (c >> 16) - 0x11) << 16) | (Math.max(0, ((c >> 8) & 0xff) - 0x11) << 8) | Math.max(0, (c & 0xff) - 0x11);

export function drawObject(g: Graphics, o: SceneObject, T: number): void {
  const x = o.x * T;
  const y = o.y * T;
  const w = o.w * T;
  const h = o.h * T;
  const c = hex(o.colour, 0x8a6a4a);
  switch (o.kind) {
    case 'painting':
    case 'poster': {
      const frame = o.kind === 'painting' ? 0x6b4a2f : 0xf4f1ea;
      g.rect(x + 2, y + 2, w - 4, h - 4).fill(frame);
      const rows = o.pixels ?? [];
      if (rows.length) {
        const inner = { x: x + 5, y: y + 5, w: w - 10, h: h - 10 };
        // Fractional pixels when the frame is small, so the art always fits inside it.
        const fit = Math.min(inner.w / rows[0]!.length, inner.h / rows.length);
        const px = fit >= 1 ? Math.floor(fit) : fit;
        const ox = inner.x + (inner.w - px * rows[0]!.length) / 2;
        const oy = inner.y + (inner.h - px * rows.length) / 2;
        rows.forEach((row, j) =>
          [...row].forEach((ch, i) => {
            const col = o.palette?.[ch];
            if (col) g.rect(ox + i * px, oy + j * px, px, px).fill(hex(col, 0));
          }),
        );
      }
      break;
    }
    case 'plant':
      g.rect(x + w / 2 - 7, y + h - 12, 14, 12).fill(0xb5654a);
      g.circle(x + w / 2, y + h - 18, Math.min(w, h) / 3).fill(hex(o.colour, 0x4f9a5c));
      g.circle(x + w / 2 - 6, y + h - 24, Math.min(w, h) / 5).fill(0x5fb06b);
      break;
    case 'rug':
      g.roundRect(x + 2, y + 2, w - 4, h - 4, 6).fill(hex(o.colour, 0x9b4d5f));
      g.roundRect(x + 6, y + 6, w - 12, h - 12, 4).stroke({ color: 0xf3e7c9, width: 2, alpha: 0.6 });
      break;
    case 'lamp':
      g.circle(x + w / 2, y + 10, 14).fill({ color: 0xfff1b8, alpha: 0.25 });
      g.rect(x + w / 2 - 1, y + 10, 3, h - 14).fill(0x3a3346);
      g.poly([x + w / 2 - 9, y + 12, x + w / 2 + 9, y + 12, x + w / 2 + 5, y + 2, x + w / 2 - 5, y + 2]).fill(hex(o.colour, 0xf2b544));
      g.rect(x + w / 2 - 6, y + h - 5, 12, 4).fill(0x3a3346);
      break;
    case 'sofa':
      g.roundRect(x + 2, y + h * 0.35, w - 4, h * 0.6, 6).fill(c);
      g.roundRect(x + 2, y + h * 0.15, w - 4, h * 0.3, 5).fill(darken(hex(o.colour, 0x8a6a4a)));
      break;
    case 'bookshelf': {
      g.rect(x + 2, y + 2, w - 4, h - 4).fill(0x6b4a2f);
      const books = [0xc0504d, 0x4f9a5c, 0xe0a23b, 0x3a9bb5, 0x7a5cc2];
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < Math.floor((w - 8) / 6); i++) g.rect(x + 4 + i * 6, y + 6 + row * ((h - 8) / 3), 4, (h - 8) / 3 - 4).fill(books[(i + row) % books.length]!);
      }
      break;
    }
    case 'watercooler':
      g.rect(x + w / 2 - 7, y + h * 0.45, 14, h * 0.5).fill(0xdfe6ee);
      g.roundRect(x + w / 2 - 6, y + 4, 12, h * 0.42, 4).fill({ color: 0x7fd1ff, alpha: 0.8 });
      break;
    case 'whiteboard':
      g.rect(x + 2, y + 2, w - 4, h - 4).fill(0xf4f1ea).stroke({ color: 0x9b93a6, width: 2 });
      break;
    case 'window':
      g.rect(x + 2, y + 2, w - 4, h - 4).fill(0x9fd3f0).stroke({ color: 0xf4f1ea, width: 3 });
      g.moveTo(x + w / 2, y + 2).lineTo(x + w / 2, y + h - 2).stroke({ color: 0xf4f1ea, width: 2 });
      break;
    case 'table':
      g.roundRect(x + 2, y + 4, w - 4, h - 8, 4).fill(c);
      break;
    case 'trophy':
      g.rect(x + w / 2 - 5, y + h - 8, 10, 6).fill(0x6b4a2f);
      g.poly([x + w / 2 - 8, y + 6, x + w / 2 + 8, y + 6, x + w / 2 + 4, y + h - 10, x + w / 2 - 4, y + h - 10]).fill(0xf2c84b);
      break;
    case 'sign':
      g.roundRect(x + 2, y + 4, w - 4, h - 10, 3).fill(hex(o.colour, 0x2f3a45));
      break;
    // Office admin: a wall calendar, a to-do board, a filing cabinet, in/out trays, letters.
    case 'calendar': {
      g.rect(x + 2, y + 3, w - 4, h - 5).fill(0xfbfaf5).stroke({ color: 0x9b93a6, width: 1 });
      g.rect(x + 2, y + 3, w - 4, Math.max(6, h * 0.22)).fill(hex(o.colour, 0xc0504d));
      for (const rx of [x + w * 0.3, x + w * 0.7]) g.rect(rx - 1, y, 2, 6).fill(0x3a3346);
      const top = y + 3 + Math.max(6, h * 0.22) + 3;
      const cw = (w - 10) / 5;
      const ch = (y + h - 4 - top) / 4;
      for (let r = 0; r < 4; r++) for (let i = 0; i < 5; i++) g.rect(x + 5 + i * cw, top + r * ch, cw - 1.5, ch - 1.5).fill(0xe6e1d6);
      g.circle(x + 5 + 2.5 * cw, top + 1.5 * ch, Math.min(cw, ch) * 0.75).stroke({ color: 0xc0504d, width: 1.5 });
      break;
    }
    case 'kanban': {
      g.rect(x + 2, y + 2, w - 4, h - 4).fill(0xf4f1ea).stroke({ color: 0x6b4a2f, width: 2 });
      const cols = 3;
      const cw = (w - 8) / cols;
      const notes = [0xf2c84b, 0x7fd1ff, 0x9fe0a0, 0xf6a6b2];
      for (let i = 0; i < cols; i++) {
        if (i) g.rect(x + 4 + i * cw, y + 5, 1, h - 10).fill(0xc9c2b4);
        for (let n = 0; n < 3 - i; n++) g.rect(x + 6 + i * cw, y + 6 + n * 8, cw - 5, 6).fill(notes[(i + n) % notes.length]!);
      }
      break;
    }
    case 'cabinet': {
      g.rect(x + 3, y + 2, w - 6, h - 3).fill(hex(o.colour, 0x8a8f99));
      g.rect(x + 3, y + h - 3, w - 6, 2).fill(0x4a4f59);
      const dh = (h - 8) / 3;
      for (let d = 0; d < 3; d++) {
        g.rect(x + 6, y + 4 + d * dh, w - 12, dh - 3).fill(darken(hex(o.colour, 0x8a8f99)));
        g.rect(x + w / 2 - 4, y + 6 + d * dh, 8, 3).fill(0xf4f1ea);
        g.rect(x + w / 2 - 3, y + 4 + d * dh + dh / 2, 6, 2).fill(0x3a3346);
      }
      break;
    }
    case 'trays': {
      for (let t = 0; t < 2; t++) {
        const ty = y + 4 + t * (h / 2 - 2);
        g.rect(x + 6, ty, w - 12, 4).fill(0xffffff);
        g.rect(x + 7, ty - 2, w - 16, 3).fill(0xf4f1ea);
        g.rect(x + 3, ty + 4, w - 6, 5).fill(hex(o.colour, 0x6b4a2f));
      }
      break;
    }
    case 'letters': {
      const env = (ex: number, ey: number, stamp: number) => {
        g.rect(ex, ey, 16, 11).fill(0xfbfaf5).stroke({ color: 0x9b93a6, width: 1 });
        g.moveTo(ex, ey).lineTo(ex + 8, ey + 6).lineTo(ex + 16, ey).stroke({ color: 0x9b93a6, width: 1 });
        g.rect(ex + 12, ey + 1, 3, 3).fill(stamp);
      };
      env(x + 3, y + h - 15, 0xc0504d);
      env(x + w - 19, y + h - 19, 0x3a9bb5);
      env(x + w / 2 - 8, y + h - 23, 0x4f9a5c);
      break;
    }
  }
}
