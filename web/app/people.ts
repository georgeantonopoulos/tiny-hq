// People in the office: each one has a home spot behind their desk, a walk
// cycle, and a speech bubble. At home they live inside their room (so the desk
// hides their legs); while walking they move onto the hallway layer above all
// rooms. Original pixel art, drawn in code.

import { drawPixels, lookFor, personPixels, SPRITE_W, type Frame, type Palette } from './sprites.ts';

type Container = import('pixi.js').Container;
type Graphics = import('pixi.js').Graphics;

export interface Point {
  x: number;
  y: number;
}

const SPEED = 320; // px per second: a brisk trot, so a trip across the floor takes a few seconds
const STEP_MS = 85; // walk-cycle frame time (quicker steps to match)
const PX = 3; // screen pixels per sprite pixel
const HALF = (SPRITE_W * PX) / 2;
const SPRITE_H_PX = 16 * PX;

export class Person {
  readonly id: string;
  readonly name: string;
  readonly root: Container = new PIXI.Container();
  readonly #frames: Record<Frame, Graphics>;
  readonly #body: Container = new PIXI.Container();
  readonly #bubble: Container = new PIXI.Container();
  readonly #bubbleBg: Graphics = new PIXI.Graphics();
  readonly #bubbleText: import('pixi.js').Text;
  #until = 0;
  #path: Point[] = [];
  #onArrive: (() => void) | undefined;
  #stepT = 0;
  #nextBlink = 0; // ms until the next blink
  #frame: Frame = 'idle';
  readonly #phase: number;
  readonly home: Point; // world coordinates
  readonly #homeParent: Container;
  #hallway: Container | undefined;
  typing = false; // busy at the desk: faster bob, and a "…" over their head
  readonly #dots: Graphics = new PIXI.Graphics();
  mood: 'idle' | 'working' | 'blocked' = 'idle';
  #trick: { kind: 'spin' | 'hop'; t: number; face: number } | undefined; // a happening's little move (see antics.ts)

  constructor(o: { id: string; name: string; palette: Palette; tie: string; home: Point; homeParent: Container; homeIndex?: number; phase?: number }) {
    this.id = o.id;
    this.name = o.name;
    this.home = o.home;
    this.#homeParent = o.homeParent;
    this.#phase = o.phase ?? 0;
    const look = lookFor(o.id === 'manager' ? 'Manager' : o.name);
    const draw = (f: Frame) => {
      const g = new PIXI.Graphics();
      drawPixels(g, personPixels(o.palette, o.tie, f, look), 0, 0, PX);
      g.visible = f === 'idle';
      this.#body.addChild(g);
      return g;
    };
    this.#frames = { idle: draw('idle'), blink: draw('blink'), stepA: draw('stepA'), stepB: draw('stepB') };
    // A soft shadow under their feet, then the body. Sprites are 36px wide;
    // flip around their middle when walking left.
    this.root.addChild(new PIXI.Graphics().ellipse(HALF, SPRITE_H_PX, 14, 4).fill({ color: 0x000000, alpha: 0.18 }));
    this.#body.pivot.set(HALF, 0);
    this.#body.position.set(HALF, 0);
    this.root.addChild(this.#body);
    this.#nextBlink = 1500 + (this.#phase * 613) % 3000;
    this.#bubbleText = new PIXI.Text({ text: '', style: { fontFamily: 'ui-rounded, system-ui', fontSize: 11, fill: 0x221d28, wordWrap: true, wordWrapWidth: 220 } });
    this.#bubbleText.position.set(8, 6);
    this.#bubble.addChild(this.#bubbleBg, this.#bubbleText);
    this.#bubble.visible = false;
    this.root.addChild(this.#bubble);
    this.#dots.visible = false;
    this.root.addChild(this.#dots);
    this.#goHome(o.homeIndex);
  }

  // A happening's move, played at their desk: a chair spin or a happy hop (about a second).
  trick(kind: 'spin' | 'hop'): void {
    this.#trick = { kind, t: 0, face: this.#body.scale.x < 0 ? -1 : 1 }; // the way they were facing
  }

  get walking(): boolean {
    return this.#path.length > 0;
  }

  // Where the person is now, in world coordinates.
  get position(): Point {
    if (this.root.parent === this.#homeParent) return { x: this.#homeParent.x + this.root.x, y: this.#homeParent.y + this.root.y };
    return { x: this.root.x, y: this.root.y };
  }

  #goHome(index = 1): void {
    this.#homeParent.addChildAt(this.root, Math.min(index, this.#homeParent.children.length));
    this.root.position.set(this.home.x - this.#homeParent.x, this.home.y - this.#homeParent.y);
  }

  say(text: string, ms = 6000): void {
    const plain = text.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
    this.#bubbleText.text = plain.length > 220 ? `${plain.slice(0, 217)}…` : plain;
    const w = Math.min(236, this.#bubbleText.width + 16);
    const h = this.#bubbleText.height + 12;
    this.#bubbleBg.clear().roundRect(0, 0, w, h, 7).fill(0xfdfaf3).poly([10, h, 16, h + 8, 22, h]).fill(0xfdfaf3);
    this.#bubble.position.set(4, -h - 10);
    this.#bubble.visible = true;
    this.#until = performance.now() + ms;
  }

  // Walk along world-coordinate points. Leaves home onto the hallway layer.
  walk(points: Point[], hallway: Container, onArrive?: () => void): void {
    if (!points.length) {
      onArrive?.();
      return;
    }
    const start = this.position;
    if (this.root.parent !== hallway) {
      hallway.addChild(this.root);
      this.root.position.set(start.x, start.y);
    }
    this.#hallway = hallway;
    this.#path = [...points];
    this.#onArrive = onArrive;
  }

  // Walk back along points and sit down again behind the desk.
  walkHome(points: Point[], hallway: Container, onArrive?: () => void): void {
    this.walk([...points, this.home], hallway, () => {
      this.#goHome();
      onArrive?.();
    });
  }

  tick(dtMs: number, t: number): void {
    if (this.#bubble.visible && performance.now() > this.#until) this.#bubble.visible = false;
    if (this.#path.length) {
      const target = this.#path[0]!;
      const dx = target.x - this.root.x;
      const dy = target.y - this.root.y;
      const dist = Math.hypot(dx, dy);
      const step = (SPEED * dtMs) / 1000;
      if (dist <= step) {
        this.root.position.set(target.x, target.y);
        this.#path.shift();
        if (!this.#path.length) {
          this.#setFrame('idle');
          const done = this.#onArrive;
          this.#onArrive = undefined;
          done?.();
          return;
        }
      } else {
        this.root.position.set(this.root.x + (dx / dist) * step, this.root.y + (dy / dist) * step);
        if (Math.abs(dx) > 0.5) this.#body.scale.x = dx < 0 ? -1 : 1;
      }
      this.#stepT += dtMs;
      if (this.#stepT > STEP_MS) {
        this.#stepT = 0;
        this.#setFrame(this.#frame === 'stepA' ? 'stepB' : 'stepA');
      }
      this.#body.y = 0;
      return;
    }
    // At rest: blink now and then, and a gentle bob, faster when working or typing.
    this.#nextBlink -= dtMs;
    if (this.#nextBlink <= 0) {
      if (this.#frame === 'blink') {
        this.#setFrame('idle');
        this.#nextBlink = 2500 + Math.random() * 3500;
      } else {
        this.#setFrame('blink');
        this.#nextBlink = 130;
      }
    } else if (this.#frame !== 'idle' && this.#frame !== 'blink') this.#setFrame('idle');
    const busy = this.typing || this.mood === 'working';
    this.#dots.visible = busy;
    if (busy) {
      const g = this.#dots.clear().roundRect(HALF - 13, -16, 26, 12, 6).fill({ color: 0xfdfaf3, alpha: 0.95 });
      for (let i = 0; i < 3; i++) {
        const up = Math.max(0, Math.sin(t / 160 - i * 0.9)) * 2;
        g.circle(HALF - 7 + i * 7, -10 - up, 2).fill(0x5d5470);
      }
    }
    this.#body.y = busy ? Math.round(Math.sin((t + this.#phase * 97) / 90) * 1.5) : Math.round(Math.sin((t + this.#phase * 97) / 800));
    if (this.#trick) {
      const k = (this.#trick.t += dtMs) / 1200;
      if (k >= 1) {
        this.#body.scale.x = this.#trick.face;
        this.#trick = undefined;
      } else if (this.#trick.kind === 'spin') this.#body.scale.x = this.#trick.face * (Math.cos(k * Math.PI * 4) || 0.01); // two turns
      else this.#body.y -= Math.round(Math.abs(Math.sin(k * Math.PI * 2)) * 9); // two hops
    }
    void this.#hallway;
  }

  #setFrame(f: Frame): void {
    if (f === this.#frame) return;
    this.#frames[this.#frame].visible = false;
    this.#frames[f].visible = true;
    this.#frame = f;
  }

  addToBody(child: Container | Graphics): void {
    this.#body.addChild(child);
  }

  // A small pill under their feet saying which model they're running on.
  #badge?: Container;
  setBadge(text: string, colour: number): void {
    this.#badge?.destroy({ children: true });
    const c = new PIXI.Container();
    const t = new PIXI.Text({ text, style: { fontFamily: 'ui-rounded, system-ui', fontSize: 8, fontWeight: '700', fill: 0x1d1a24 } });
    const w = t.width + 8;
    const bg = new PIXI.Graphics().roundRect(0, 0, w, 11, 5).fill(colour);
    t.position.set(4, 0.5);
    c.addChild(bg, t);
    c.position.set(HALF - w / 2, 52);
    this.root.addChild(c);
    this.#badge = c;
  }
}
