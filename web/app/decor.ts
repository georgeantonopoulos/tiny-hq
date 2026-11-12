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
  }
}
