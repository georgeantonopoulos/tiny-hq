// The office floor, drawn with PixiJS from the floor plan the daemon sends.
// Original art: flat shapes and code-drawn pixel sprites. A sunny studio by
// day; after dark the lights go down and the screens and lamps glow.

import type { Floor, Room } from '../../src/office/layout.ts';
import { darker } from './sprites.ts';
import { Person, type Point } from './people.ts';
import { drawObject } from './decor.ts';
import { drawProp, effect, type Effect } from './antics.ts';
import type { Anim, Prop } from './whimsy.ts';
import { Bubbles, type Answer, type AskInfo, type Speaker } from './bubbles.ts';
import type { SceneObject } from '../../src/office/scene.ts';

type Graphics = import('pixi.js').Graphics;
type Container = import('pixi.js').Container;

export { TILE } from './furniture.ts';
import { TILE, desksIn } from './furniture.ts';

// Daytime between 7:00 and 19:00, local time. `?light=night` (or `day`) in the
// address pins one, to see it without waiting for the clock.
export function isNight(d = new Date()): boolean {
  const pinned = new URLSearchParams(location.search).get('light');
  if (pinned === 'night' || pinned === 'day') return pinned === 'night';
  const h = d.getHours();
  return h < 7 || h >= 19;
}

interface Theme {
  night: boolean;
  void: number;
  hall: number; // hallway tiles, two tones
  hallAlt: number;
  hallLine: number;
  wall: number; // back wall of each room
  wallLine: number;
  trim: number; // skirting under the back wall
  edge: number; // outline walls
  floors: number[]; // wood, quiet -> busy
  manager: number;
  archive: number;
  custom: number;
  plank: number;
  plankAlpha: number;
  rugAlpha: number;
  desk: number;
  deskTop: number;
  monitor: number;
  screenOn: number;
  screenOff: number;
  chair: number;
  pot: number;
  potRim: number;
  leaves: number[];
  text: number;
  muted: number;
  plate: number;
  plateText: number;
  sky: number;
  skyLow: number;
  frame: number;
}

// Rugs and accents, picked per room so neighbours differ.
const RUGS = [0xe07a5f, 0x81b29a, 0xf2cc8f, 0x7d9cc9, 0xc59fc9, 0xe8a87c];

const DAY: Theme = {
  night: false,
  void: 0x1d1820,
  hall: 0x2e2732,
  hallAlt: 0x29222d,
  hallLine: 0x352d3a,
  wall: 0xf7efe2,
  wallLine: 0xe8dcc8,
  trim: 0xb98d5e,
  edge: 0x7a5a40,
  floors: [0xcdb08c, 0xd4a774, 0xdba56a, 0xe2a35e],
  manager: 0xd09c64,
  archive: 0xbba78f,
  custom: 0xc8ad8c,
  plank: 0x5a3214,
  plankAlpha: 0.13,
  rugAlpha: 0.85,
  desk: 0x8b5a3c,
  deskTop: 0xa8714b,
  monitor: 0x26233a,
  screenOn: 0x9be7ff,
  screenOff: 0x4a4560,
  chair: 0x5c4b7a,
  pot: 0xc8693f,
  potRim: 0xd9804f,
  leaves: [0x3f8f52, 0x57ab63, 0x79c47a],
  text: 0x3b2a1e,
  muted: 0x8a6f55,
  plate: 0xfdf5e6,
  plateText: 0x3b2a1e,
  sky: 0xa8dcf5,
  skyLow: 0xc7ecfb,
  frame: 0xffffff,
};

const NIGHT: Theme = {
  ...DAY,
  night: true,
  void: 0x0a0b14,
  hall: 0x13152a,
  hallAlt: 0x101224,
  hallLine: 0x191c35,
  wall: 0x3a3a5e,
  wallLine: 0x34345a,
  trim: 0x5a4a6a,
  edge: 0x1c1a30,
  floors: [0x4d4256, 0x56455a, 0x5e4858, 0x684a54],
  manager: 0x5a4858,
  archive: 0x47405a,
  custom: 0x4d4458,
  plank: 0x000000,
  plankAlpha: 0.12,
  rugAlpha: 0.5,
  desk: 0x5a3e36,
  deskTop: 0x6e4c40,
  chair: 0x3d3358,
  pot: 0x7a4a3a,
  potRim: 0x8a5644,
  leaves: [0x2a5a48, 0x357058, 0x418564],
  text: 0xf3eefc,
  muted: 0xa9a2c8,
  plate: 0x22203a,
  plateText: 0xf3eefc,
  sky: 0x0b1030,
  skyLow: 0x141a44,
  frame: 0x55557e,
};

const hexOr = (c: string | undefined, f: number) => (c && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : f);
// Per channel: scale towards black (k < 1) for saved colours at night.
const dim = (c: number, k: number) => (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);

function seed(s: string): number {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function ago(ms: number): string {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export interface OfficeHandlers {
  onRoom(room: Room): void;
  onManager(): void;
  onBoard?(): void; // the manager's whiteboard was clicked
  onTimetable?(): void; // the timetable on the manager's wall was clicked
  onDesk?(): void; // the owner's desk was clicked
  onCoffee?(): void; // the coffee room was clicked: its board
  onEmpty(): void;
}

const WALL_H = 46; // back wall band at the top of each room, where the name sits

export class Office {
  readonly app = new PIXI.Application();
  private world!: Container;
  private manager?: Person;
  private floor?: Floor;
  private handlers?: OfficeHandlers;
  private people = new Map<string, Person>();
  private colourOf = new Map<string, string>(); // person id -> shirt colour (their bubble's name tag)
  private bubbles?: Bubbles;
  private hallway?: Container; // people walking between rooms are drawn here, above every room
  private away = new Map<string, Room>(); // person id -> the room they're standing in, while visiting
  private sparks: { g: Graphics; vx: number; vy: number; life: number }[] = [];
  private fx: Effect[] = []; // happenings' moves playing out
  private props = new Map<string, { g: Graphics; until: number }>(); // person id -> a happening's prop beside them
  // The camera: glides to whoever's busy or talking, then back to the whole floor.
  private cam: { x: number; y: number; s: number; until: number } | null = null;
  private lastTouch = 0; // the owner panned or zoomed: the camera leaves them alone for a while
  private t = 0;
  private th: Theme = isNight() ? NIGHT : DAY;
  private wallColour = this.th.wall;
  private edgeColour = this.th.edge;

  async mount(host: HTMLElement, handlers: OfficeHandlers): Promise<void> {
    await this.app.init({ resizeTo: host, background: this.th.void, antialias: false, roundPixels: true, autoDensity: true, resolution: devicePixelRatio });
    host.prepend(this.app.canvas);
    this.world = new PIXI.Container();
    this.app.stage.addChild(this.world);
    this.enablePanZoom(host, handlers);
    this.bubbles = new Bubbles(host, (id) => {
      const room = this.roomOf(id);
      if (!room || room.kind === 'staff') return; // staff have no chat to open: their bubble is the report
      if (room.kind === 'manager') handlers.onManager();
      else handlers.onRoom(room);
    });
    this.app.ticker.add((tk) => this.animate(tk.deltaMS));
    document.addEventListener('visibilitychange', () => (document.hidden ? this.app.ticker.stop() : this.app.ticker.start()));
    // Day turns to night (and back): redraw in the other light.
    setInterval(() => {
      if (!this.floor || !this.handlers || isNight() === this.th.night) return;
      // Keep where the owner was looking, and who was typing.
      const view = { x: this.world.x, y: this.world.y, s: this.world.scale.x };
      const typing = [...this.people].filter(([, p]) => p.typing).map(([id]) => id);
      this.render(this.floor, this.handlers);
      this.world.scale.set(view.s);
      this.world.position.set(view.x, view.y);
      for (const id of typing) {
        const p = this.people.get(id);
        if (p) p.typing = true;
      }
    }, 60_000);
  }

  get current(): Floor | undefined {
    return this.floor;
  }

  render(floor: Floor, handlers: OfficeHandlers): void {
    this.floor = floor;
    this.handlers = handlers;
    this.th = isNight() ? NIGHT : DAY;
    const th = this.th;
    document.documentElement.dataset.light = th.night ? 'night' : 'day';
    this.world.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.people.clear();
    this.away.clear();
    this.pills.clear();
    this.screens.clear();
    this.sparks = [];
    const W = floor.width * TILE;
    const H = floor.height * TILE;

    // Hallway: dark two-tone tiles, so the lit rooms stand out (colours can come from the saved decor).
    const theme = (floor as Floor & { theme?: { corridor?: string; wall?: string; background?: string } }).theme ?? {};
    const k = th.night ? 0.45 : 1;
    this.wallColour = theme.wall ? dim(hexOr(theme.wall, th.wall), k) : th.wall;
    this.edgeColour = theme.wall && /^#[0-9a-f]{6}$/i.test(theme.wall) ? parseInt(darker(theme.wall, th.night ? 0.7 : 0.4).slice(1), 16) : th.edge;
    this.app.renderer.background.color = theme.background ? dim(hexOr(theme.background, th.void), k) : th.void;
    const hall = theme.corridor ? dim(hexOr(theme.corridor, th.hall), k) : th.hall;
    const base = new PIXI.Graphics().rect(0, 0, W, H).fill(hall);
    for (let y = 0; y < floor.height; y++)
      for (let x = 0; x < floor.width; x++) {
        if ((x + y) % 2) base.rect(x * TILE, y * TILE, TILE, TILE).fill({ color: theme.corridor ? 0x000000 : th.hallAlt, alpha: theme.corridor ? 0.1 : 1 });
        base.rect(x * TILE, y * TILE, TILE, 1).fill({ color: th.hallLine, alpha: 0.6 });
      }
    this.world.addChild(base);

    for (const room of floor.rooms) this.world.addChild(this.drawRoom(room, handlers));
    this.hallway = new PIXI.Container();

    // Front door on the top wall, by the manager's office, with a welcome mat.
    const door = new PIXI.Graphics()
      .rect(floor.door.x * TILE, 0, TILE * 2, 6)
      .fill(0xf2b544)
      .roundRect(floor.door.x * TILE + 6, 8, TILE * 2 - 12, 10, 3)
      .fill(th.night ? 0x5a3e36 : 0x9b4d5f);
    this.world.addChild(door);
    this.world.addChild(this.hallway);

    for (const agent of floor.agents) {
      if (agent.id !== 'manager') continue;
      this.manager = this.drawManager(agent.x * TILE, agent.y * TILE, agent.palette, handlers);
    }
    this.fit();
    // Everyone was drawn afresh: markers and bubbles follow the new figures.
    this.bubbles?.rebind((id) => {
      const p = this.people.get(id);
      return p ? this.speaker(id, p) : undefined;
    });
  }

  // Soft light: a few stacked circles, brightest in the middle.
  private glow(g: Graphics, x: number, y: number, r: number, color: number, alpha: number): void {
    for (let i = 10; i >= 1; i--) g.circle(x, y, (r * i) / 10).fill({ color, alpha: alpha / 10 });
  }

  private drawRoom(room: Room, handlers: OfficeHandlers): Container {
    const th = this.th;
    const c = new PIXI.Container();
    c.position.set(room.x * TILE, room.y * TILE);
    const w = room.w * TILE;
    const h = room.h * TILE;
    const g = new PIXI.Graphics();
    const styleFloor = room.style?.floor && /^#[0-9a-f]{6}$/i.test(room.style.floor) ? dim(parseInt(room.style.floor.slice(1), 16), th.night ? 0.45 : 1) : undefined;
    const busy = room.project?.activity ?? 0;
    const fill =
      styleFloor ??
      (room.kind === 'manager'
        ? th.manager
        : room.kind === 'archive'
          ? th.archive
          : room.kind === 'lounge'
            ? th.floors[2]!
          : room.kind === 'custom'
            ? th.custom
            : th.floors[Math.min(th.floors.length - 1, Math.floor(busy * th.floors.length))]!);
    const wall = room.style?.wall && /^#[0-9a-f]{6}$/i.test(room.style.wall) ? dim(parseInt(room.style.wall.slice(1), 16), th.night ? 0.45 : 1) : this.wallColour;
    const s = seed(room.id);

    // Wooden floor: planks with staggered joints.
    g.rect(0, 0, w, h).fill(fill);
    for (let y = WALL_H + 10, row = 0; y < h; y += 10, row++) {
      g.rect(0, y, w, 1).fill({ color: th.plank, alpha: th.plankAlpha });
      for (let x = ((row * 23 + s) % 64) - 64; x < w; x += 64) if (x > 0) g.rect(x, y - 10, 1, 10).fill({ color: th.plank, alpha: th.plankAlpha });
    }
    // Back wall with panelling, skirting and a shadow on the floor.
    g.rect(0, 0, w, WALL_H).fill(wall);
    for (let x = 10; x < w; x += 12) g.rect(x, WALL_H - 18, 1, 14).fill(th.wallLine);
    g.rect(0, WALL_H - 4, w, 4).fill(th.trim);
    g.rect(0, WALL_H, w, 3).fill({ color: 0x000000, alpha: 0.12 });
    // Window on the back wall (bigger rooms): sky by day, a starry city by night.
    if (room.w >= 7) this.window(g, w - 70, 6, 52, 30, s);
    // Outline walls, with a doorway in the bottom one.
    g.rect(0, 0, 5, h).fill(this.edgeColour);
    g.rect(w - 5, 0, 5, h).fill(this.edgeColour);
    g.rect(0, h - 5, w, 5).fill(this.edgeColour);
    g.rect(w / 2 - TILE / 2, h - 5, TILE, 5).fill(fill);
    // Night: a dim wash over quiet rooms; busy rooms keep their lights on.
    if (th.night && room.kind === 'project' && Date.now() - (room.project?.lastActive ?? 0) > 3600_000) g.rect(5, 0, w - 10, h - 5).fill({ color: 0x05060f, alpha: 0.25 });

    // Furniture: rugs and wall things go on the floor layer (under the people,
    // who stand at index 1), desks and plants in front of them.
    if (room.kind === 'project') this.furnishProject(c, g, room, s);
    if (room.kind === 'archive') this.furnishArchive(g, room);
    if (room.kind === 'manager') this.furnishManager(c, g, room);
    if (room.kind === 'lounge') this.furnishLounge(c, g, room);
    if (room.kind === 'staff') this.furnishStaff(c, g, room);
    if (room.kind === 'desk') this.furnishDesk(c, g, room);
    c.addChildAt(g, 0);
    // Saved decor: paintings, plants, rugs... drawn into the floor layer, so it
    // stays under the people however and whenever they're added.
    const objects = ((this.floor as Floor & { objects?: SceneObject[] })?.objects ?? []).filter((o) => o.room === room.id);
    for (const o of objects) drawObject(g, o, TILE);

    // Name on the back wall.
    const label = new PIXI.Text({
      text: room.name,
      style: { fontFamily: 'ui-rounded, system-ui, sans-serif', fontSize: 13, fontWeight: '800', fill: th.text },
    });
    label.position.set(11, 7);
    c.addChild(label);
    // Source badges as coloured lights just after the name: Claude, Codex, git.
    if (room.project) {
      const colours: Record<string, number> = { claude: 0xe08a5b, codex: 0x7fb8a4, git: 0xf2b544 };
      const lights = new PIXI.Graphics();
      room.project.sources.forEach((src, i) => lights.circle(label.x + label.width + 9 + i * 10, 15, 3.5).fill(colours[src] ?? 0xffffff));
      c.addChild(lights);
    }
    const sub =
      room.kind === 'project' && room.project
        ? `${ago(room.project.lastActive)} · ${room.project.recentSessions} this month`
        : room.kind === 'archive'
          ? `${room.count} quieter projects filed here`
          : room.kind === 'lounge'
            ? 'Rooms swap what they learned · tap for the board'
          : room.kind === 'custom'
            ? 'Extra room'
          : room.kind === 'staff'
            ? (room.staff?.role ?? '')
          : room.kind === 'desk'
            ? 'Reports for you'
            : 'The manager · the whole office';
    const subText = new PIXI.Text({ text: sub, style: { fontFamily: 'ui-rounded, system-ui, sans-serif', fontSize: 10, fill: th.muted } });
    subText.position.set(11, 24);
    c.addChild(subText);

    // Hover and click.
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.hitArea = new PIXI.Rectangle(0, 0, w, h);
    const hover = new PIXI.Graphics().roundRect(1, 1, w - 2, h - 2, 3).stroke({ color: 0xf2b544, width: 3, alpha: 0.95 });
    hover.visible = false;
    c.addChild(hover);
    c.on('pointerover', () => (hover.visible = true));
    c.on('pointerout', () => (hover.visible = false));
    c.on('pointertap', (e) => {
      e.stopPropagation();
      if (this.gestured) return; // that was a pan or pinch, not a tap
      if (room.kind === 'manager') handlers.onManager();
      else if (room.kind === 'desk') handlers.onDesk?.();
      else if (room.kind === 'lounge') handlers.onCoffee?.();
      else if (room.kind !== 'staff') handlers.onRoom(room);
    });
    return c;
  }

  private window(g: Graphics, x: number, y: number, w: number, h: number, s: number): void {
    const th = this.th;
    g.rect(x, y, w, h).fill(th.frame);
    g.rect(x + 3, y + 3, w - 6, h - 6).fill(th.sky);
    g.rect(x + 3, y + h * 0.6, w - 6, h * 0.4 - 3).fill(th.skyLow);
    if (th.night) {
      for (let i = 0; i < 9; i++) g.rect(x + 5 + ((i * 7 + s) % (w - 10)), y + 6 + ((i * 5 + s) % (h - 12)), 2, 2).fill(i % 3 ? 0xffd36b : 0x7cf3ff);
      g.circle(x + w - 12, y + 10, 3).fill(0xfdf3c8);
    } else {
      g.roundRect(x + 7 + (s % 12), y + 8, 11, 4, 2).fill(0xffffff);
      g.roundRect(x + 26 + (s % 7), y + 13, 8, 3, 2).fill(0xffffff);
    }
    g.rect(x + w / 2 - 1, y + 3, 2, h - 6).fill(th.frame);
    g.rect(x - 2, y + h, w + 4, 3).fill(th.trim);
  }

  // A desk monitor that's on while that person's Claude session is running.
  private screens = new Map<string, Graphics>();
  private addScreen(id: string, c: Container, x: number, y: number): void {
    const glow = new PIXI.Graphics()
      .rect(x + 21, y - 14, 22, 12)
      .fill(this.th.screenOn)
      .rect(x + 23, y - 12, 10, 1)
      .fill({ color: 0x14284f, alpha: 0.55 })
      .rect(x + 23, y - 9, 16, 1)
      .fill({ color: 0x14284f, alpha: 0.55 })
      .rect(x + 23, y - 6, 8, 1)
      .fill({ color: 0x14284f, alpha: 0.55 });
    glow.visible = false;
    c.addChild(glow);
    this.screens.set(id, glow);
  }

  // A small coloured pill: which Claude model someone's on.
  private pills = new Map<string, Container>();
  private modelPill(model: string): Container {
    const c = new PIXI.Container();
    const t = new PIXI.Text({ text: model[0]!.toUpperCase() + model.slice(1), style: { fontFamily: 'ui-rounded, system-ui', fontSize: 9, fontWeight: '700', fill: 0x1d1a24 } });
    const bg = new PIXI.Graphics().roundRect(0, 0, t.width + 10, 13, 6).fill(MODEL_COLOURS[model] ?? 0xa99fb5);
    t.position.set(5, 1);
    c.addChild(bg, t);
    return c;
  }

  private desk(g: Graphics, x: number, y: number, screenOn: boolean, mug: number): void {
    const th = this.th;
    const W = TILE * 2;
    g.rect(x, y, W, 22).fill(th.desk);
    g.rect(x, y, W, 5).fill(th.deskTop);
    g.rect(x + 3, y + 22, 4, 6).fill(th.desk);
    g.rect(x + W - 7, y + 22, 4, 6).fill(th.desk);
    // Monitor with a few lines of "code".
    g.rect(x + 19, y - 16, 26, 17).fill(th.monitor);
    g.rect(x + 21, y - 14, 22, 12).fill(screenOn ? th.screenOn : th.screenOff);
    if (screenOn) for (let i = 0; i < 3; i++) g.rect(x + 23, y - 12 + i * 3, 6 + ((i * 7) % 12), 1).fill({ color: 0x14284f, alpha: 0.55 });
    g.rect(x + 30, y + 1, 4, 3).fill(th.monitor);
    // Papers and a mug.
    g.rect(x + 4, y - 2, 10, 6).fill(0xfdfaf3);
    g.rect(x + 6, y - 4, 10, 6).fill(0xf1e9d8);
    g.rect(x + 50, y - 4, 7, 7).fill(mug);
    g.rect(x + 57, y - 2, 2, 3).fill(mug);
    // Chair.
    g.roundRect(x + 21, y + 26, 22, 14, 5).fill(th.chair);
  }

  private plant(g: Graphics, x: number, y: number): void {
    const th = this.th;
    g.rect(x + 4, y + 20, 16, 14).fill(th.pot);
    g.rect(x + 2, y + 18, 20, 4).fill(th.potRim);
    const leaves: [number, number, number][] = [[12, 10, 9], [5, 12, 6], [19, 12, 6], [9, 3, 6], [16, 4, 5]];
    leaves.forEach(([a, b, r], i) => g.circle(x + a, y + b, r).fill(th.leaves[i % 3]!));
  }

  private rug(g: Graphics, cx: number, cy: number, w: number, h: number, colour: number): void {
    g.roundRect(cx - w / 2, cy, w, h, 10).fill({ color: colour, alpha: this.th.rugAlpha });
    g.roundRect(cx - w / 2 + 5, cy + 5, w - 10, h - 10, 7).stroke({ color: 0xffffff, width: 2, alpha: this.th.night ? 0.25 : 0.5 });
  }

  // A name plate in front of the desk, with the model pill inside it on the right.
  private plate(c: Container, name: string, cx: number, y: number, accent: number, pill?: Container): void {
    const th = this.th;
    const t = new PIXI.Text({ text: name, style: { fontFamily: 'ui-rounded, system-ui, sans-serif', fontSize: 10, fontWeight: '700', fill: th.night ? accent : th.plateText } });
    const gap = pill ? 5 : 0;
    const inner = t.width + gap + (pill?.width ?? 0);
    const left = cx - inner / 2;
    t.position.set(left, y + 2);
    const bg = new PIXI.Graphics().roundRect(left - 8, y - (pill ? 1 : 0), inner + (pill ? 10 : 16), pill ? 18 : 16, 9).fill({ color: th.plate, alpha: 0.95 });
    c.addChild(bg, t);
    if (pill) {
      pill.position.set(left + t.width + gap, y + 1.5);
      c.addChild(pill);
    }
  }

  private furnishProject(c: Container, g: Graphics, room: Room, s: number): void {
    const th = this.th;
    const p = room.project!;
    const recent = Date.now() - p.lastActive < 24 * 3600 * 1000;
    const w = room.w * TILE;
    const h = room.h * TILE;
    const accent = RUGS[s % RUGS.length]!;
    const { x: deskX, y: deskY } = desksIn(room)[0]!;
    this.rug(g, deskX + TILE, deskY - 24, Math.min(w - 40, TILE * 4), Math.min(h - WALL_H - 16, 76), accent);
    if (th.night && recent) this.glow(g, deskX + TILE, deskY - 6, 58, th.screenOn, 0.3);
    // A poster on the wall-side of bigger rooms, a lamp by busy ones at night.
    if (room.w >= 7 && h - WALL_H > 120) {
      g.rect(14, WALL_H + 8, 26, 32).fill(th.night ? 0x2a2f55 : 0xffffff);
      g.rect(17, WALL_H + 11, 20, 18).fill(RUGS[(s >> 3) % RUGS.length]!);
      g.circle(27, WALL_H + 20, 5).fill({ color: 0xffffff, alpha: 0.6 });
      g.rect(17, WALL_H + 32, 14, 2).fill(th.night ? 0x555577 : 0xcccccc);
    }
    if (th.night && recent) {
      this.glow(g, w - 26, h - 44, 34, 0xffd36b, 0.3);
      g.rect(w - 27, h - 40, 3, 22).fill(0x3a3346);
      g.poly([w - 35, h - 40, w - 17, h - 40, w - 21, h - 50, w - 31, h - 50]).fill(0xf2b544);
      g.rect(w - 32, h - 20, 12, 4).fill(0x3a3346);
    }
    // The lead stands behind the desk (added to the room before the desk).
    if (room.lead) {
      this.addPerson(`lead:${room.id}`, room.lead.name, room.lead.palette, darker(room.lead.palette.shirt), c, room, deskX + 14, deskY - 44, room.x * 7 + room.y * 3);
    }
    const front = new PIXI.Graphics();
    this.desk(front, deskX, deskY, false, room.lead ? parseInt(room.lead.palette.shirt.slice(1), 16) : 0xffffff);
    this.plant(front, 10, h - 44);
    c.addChild(front);
    this.addScreen(`lead:${room.id}`, c, deskX, deskY);
    const pill = this.modelPill(room.model ?? 'opus');
    this.pills.set(`lead:${room.id}`, pill);
    this.plate(c, room.lead ? room.lead.name : 'lead: hiring', w / 2, Math.min(h - 22, deskY + 44), accent, pill);
  }

  private furnishArchive(g: Graphics, room: Room): void {
    const th = this.th;
    for (let i = 0; i < 3; i++) {
      const x = 14 + i * 40;
      g.rect(x, WALL_H + 10, 32, 76).fill(th.night ? 0x4a4560 : 0x8a8298);
      for (let d = 0; d < 3; d++) {
        g.rect(x + 3, WALL_H + 14 + d * 24, 26, 20).fill(th.night ? 0x5a5470 : 0xa39bb0);
        g.rect(x + 12, WALL_H + 22 + d * 24, 8, 3).fill(0xe9e2f0);
      }
    }
    // Cardboard boxes of old projects.
    const bx = room.w * TILE - 52;
    g.rect(bx, room.h * TILE - 40, 34, 26).fill(0xc79a5e);
    g.rect(bx + 4, room.h * TILE - 58, 26, 20).fill(0xd4a96a);
    g.rect(bx + 14, room.h * TILE - 40, 6, 26).fill({ color: 0x000000, alpha: 0.12 });
  }

  // The coffee room: a hanging sign, a counter with a machine, a round table, two sofas.
  private furnishLounge(c: Container, g: Graphics, room: Room): void {
    const th = this.th;
    const w = room.w * TILE;
    const h = room.h * TILE;
    this.rug(g, w / 2, WALL_H + 36, TILE * 5, 88, 0xe8a87c);
    // Counter along the left of the back wall, with the machine, cups and steam.
    g.rect(12, WALL_H + 4, 92, 26).fill(th.desk);
    g.rect(12, WALL_H + 4, 92, 5).fill(th.deskTop);
    g.rect(20, WALL_H - 22, 26, 28).fill(0x3d3a4a);
    g.rect(24, WALL_H - 18, 18, 8).fill(0x9aa0b8);
    g.rect(29, WALL_H - 4, 8, 8).fill(0xf4f1ea);
    g.rect(22, WALL_H - 22, 22, 3).fill(0xd8443c);
    for (let i = 0; i < 3; i++) g.rect(58 + i * 14, WALL_H - 6, 9, 10).fill([0xf4f1ea, 0xe07a5f, 0x7d9cc9][i]!);
    // Round table with two mugs.
    const tx = w / 2;
    const ty = WALL_H + 62;
    g.ellipse(tx, ty + 14, 30, 11).fill({ color: 0x000000, alpha: 0.14 });
    g.rect(tx - 3, ty, 6, 16).fill(th.desk);
    g.ellipse(tx, ty, 30, 12).fill(th.deskTop);
    g.rect(tx - 14, ty - 8, 9, 8).fill(0xf4f1ea);
    g.rect(tx + 7, ty - 8, 9, 8).fill(0xe07a5f);
    // Two sofas, one each side.
    for (const sx of [24, w - 24 - 34]) {
      g.roundRect(sx, h - 66, 34, 44, 8).fill(0x7d9cc9);
      g.roundRect(sx + 4, h - 58, 26, 30, 6).fill({ color: 0xffffff, alpha: 0.18 });
    }
    this.plant(g, w - 40, WALL_H + 8);
    if (th.night) this.glow(g, w / 2, WALL_H + 20, 70, 0xffc46b, 0.22);
    // The sign: hangs on two chains from the top of the room.
    const sw = 78;
    const sx = w / 2 - sw / 2;
    g.rect(sx + 10, 0, 2, 10).fill(0x6b4a2f);
    g.rect(sx + sw - 12, 0, 2, 10).fill(0x6b4a2f);
    g.roundRect(sx, 10, sw, 22, 5).fill(th.night ? 0x2a2233 : 0x4a3a30).stroke({ color: th.night ? 0xffd36b : 0xf2b544, width: 2 });
    const t = new PIXI.Text({ text: 'COFFEE', style: { fontFamily: 'ui-rounded, system-ui, sans-serif', fontSize: 12, fontWeight: '900', fill: th.night ? 0xffd36b : 0xfff3d1, letterSpacing: 1 } });
    t.position.set(sx + 22, 15);
    c.addChild(t);
    g.rect(sx + 8, 17, 9, 8).fill(0xf4f1ea).rect(sx + 17, 19, 3, 4).stroke({ color: 0xf4f1ea, width: 1 });
  }

  // The owner's desk: an empty chair, a pile of papers, and a red tag with how many are unread.
  private deskBadge?: { tag: Graphics; text: import('pixi.js').Text };
  private furnishDesk(c: Container, g: Graphics, room: Room): void {
    const w = room.w * TILE;
    const h = room.h * TILE;
    const { x: deskX, y: deskY } = desksIn(room)[0]!;
    this.rug(g, deskX + TILE, deskY - 24, Math.min(w - 40, TILE * 4), Math.min(h - WALL_H - 16, 70), 0x7d9cc9);
    // Their chair, waiting for them.
    g.roundRect(deskX + 18, deskY - 34, 28, 30, 6).fill(0x3d3a4a);
    const front = new PIXI.Graphics();
    this.desk(front, deskX, deskY, false, 0x7d9cc9);
    // The papers: a little stack on the desk.
    for (let i = 0; i < 3; i++) front.rect(deskX + 8 + i, deskY - 6 - i * 3, 22, 4).fill(i % 2 ? 0xf4f1ea : 0xffffff).stroke({ color: 0xc9c2b2, width: 1 });
    this.plant(front, 10, h - 44);
    c.addChild(front);
    const tag = new PIXI.Graphics();
    const text = new PIXI.Text({ text: '', style: { fontFamily: 'ui-rounded, system-ui, sans-serif', fontSize: 11, fontWeight: '900', fill: 0xffffff } });
    tag.position.set(deskX + 30, deskY - 26);
    text.position.set(deskX + 36, deskY - 23);
    c.addChild(tag, text);
    this.deskBadge = { tag, text };
    this.showDesk(this.deskUnread);
    this.plate(c, 'You', w / 2, Math.min(h - 22, deskY + 44), 0x7d9cc9);
  }

  // How many reports on the owner's desk they haven't opened: a red tag on the pile.
  private deskUnread = 0;
  showDesk(unread: number): void {
    this.deskUnread = unread;
    const b = this.deskBadge;
    if (!b || b.text.destroyed) return;
    b.text.text = unread ? `${unread} new` : '';
    b.tag.clear();
    if (unread) b.tag.roundRect(0, 0, b.text.width + 12, 18, 9).fill(0xd8443c);
  }

  // A staff member's room: a rug, their desk with a screen, and their name plate.
  private furnishStaff(c: Container, g: Graphics, room: Room): void {
    const st = room.staff;
    if (!st) return;
    const w = room.w * TILE;
    const h = room.h * TILE;
    const { x: deskX, y: deskY } = desksIn(room)[0]!;
    this.rug(g, deskX + TILE, deskY - 24, Math.min(w - 40, TILE * 4), Math.min(h - WALL_H - 16, 70), parseInt(st.palette.shirt.slice(1), 16));
    this.addPerson(st.id, st.name, st.palette, darker(st.palette.shirt), c, room, deskX + 14, deskY - 44, room.x * 7);
    const front = new PIXI.Graphics();
    this.desk(front, deskX, deskY, false, parseInt(st.palette.shirt.slice(1), 16));
    this.plant(front, 10, h - 44);
    c.addChild(front);
    this.addScreen(st.id, c, deskX, deskY);
    const pill = this.modelPill('sonnet');
    this.plate(c, st.name, w / 2, Math.min(h - 22, deskY + 44), 0x24292f, pill);
  }

  private furnishManager(c: Container, g: Graphics, room: Room): void {
    const th = this.th;
    const w = room.w * TILE;
    const h = room.h * TILE;
    const managerDesk = desksIn(room)[0]!;
    this.rug(g, managerDesk.x + TILE, managerDesk.y - 34, TILE * 5, 100, 0x81b29a);
    if (th.night) this.glow(g, managerDesk.x + TILE, managerDesk.y - 6, 58, th.screenOn, 0.3);
    // The whiteboard the manager loves, with a very important diagram.
    const bx = 150;
    const by = WALL_H + 6;
    g.rect(bx - 3, by - 3, 136, 76).fill(0x9b93a6);
    g.rect(bx, by, 130, 70).fill(th.night ? 0xdfe2f5 : 0xfffdf7);
    g.moveTo(bx + 12, by + 54).lineTo(bx + 40, by + 38).lineTo(bx + 66, by + 44).lineTo(bx + 114, by + 12).stroke({ color: 0x3f6fb5, width: 3 });
    g.circle(bx + 114, by + 12, 4).fill(0xd8443c);
    g.rect(bx + 20, by + 72, 20, 4).fill(0x6b6478);
    const wb = new PIXI.Text({ text: 'SYNERGY ↑', style: { fontFamily: 'ui-rounded, system-ui', fontSize: 10, fontWeight: '700', fill: 0xd8443c } });
    wb.position.set(bx + 10, by + 6);
    // A sofa for "quick syncs", and their trophy.
    const sx = w - 120;
    const sy = h - 60;
    g.rect(sx, sy, 84, 14).fill(th.night ? 0x7a3a3a : 0xc0504d);
    g.rect(sx, sy + 12, 84, 18).fill(th.night ? 0x8e4747 : 0xd9685f);
    g.rect(sx - 5, sy + 6, 9, 24).fill(th.night ? 0x632f2f : 0xa8403d);
    g.rect(sx + 80, sy + 6, 9, 24).fill(th.night ? 0x632f2f : 0xa8403d);
    g.rect(sx + 10, sy + 4, 18, 10).fill(0xf2cc8f);
    g.rect(w - 44, WALL_H + 34, 14, 5).fill(0x6b4a2f);
    g.poly([w - 46, WALL_H + 16, w - 28, WALL_H + 16, w - 32, WALL_H + 34, w - 42, WALL_H + 34]).fill(0xf2c84b);
    g.rect(w - 52, WALL_H + 39, 30, 4).fill(th.trim);
    if (th.night) this.glow(g, 36, h - 52, 40, 0xffd36b, 0.3);
    c.addChild(wb);
    // Click the whiteboard: the project board.
    const hit = new PIXI.Graphics().rect(bx - 3, by - 3, 136, 80).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointertap', (e) => {
      e.stopPropagation();
      if (this.gestured) return;
      this.handlers?.onBoard?.();
    });
    c.addChild(hit);
    // The timetable pinned beside it: a little cork board with a grid of slots.
    const tx = 62;
    const ty = WALL_H + 10;
    const tt = new PIXI.Graphics();
    tt.rect(tx - 2, ty - 2, 74, 58).fill(0x8a6a48);
    tt.rect(tx, ty, 70, 54).fill(th.night ? 0xb89a72 : 0xd9b98c);
    tt.rect(tx + 6, ty + 6, 58, 10).fill(0xfdfaf3);
    for (let r = 0; r < 3; r++) {
      tt.rect(tx + 6, ty + 20 + r * 10, 12, 7).fill(r === 1 ? 0x81b29a : 0xfdfaf3);
      tt.rect(tx + 22, ty + 20 + r * 10, 42, 7).fill(0xfdfaf3);
    }
    tt.circle(tx + 35, ty + 2, 3).fill(0xd8443c);
    const ttLabel = new PIXI.Text({ text: 'TIMETABLE', style: { fontFamily: 'ui-rounded, system-ui', fontSize: 7, fontWeight: '700', fill: 0x3f6fb5 } });
    ttLabel.position.set(tx + 10, ty + 7);
    tt.eventMode = 'static';
    tt.cursor = 'pointer';
    tt.on('pointertap', (e) => {
      e.stopPropagation();
      if (this.gestured) return;
      this.handlers?.onTimetable?.();
    });
    c.addChild(tt, ttLabel);
    // The manager stands behind their desk (drawManager adds them at index 1), desk in front.
    const front = new PIXI.Graphics();
    this.desk(front, managerDesk.x, managerDesk.y, false, 0xffd84d);
    this.plant(front, 12, h - 44);
    c.addChild(front);
    this.addScreen('manager', c, managerDesk.x, managerDesk.y);
    const pill = this.modelPill('opus');
    pill.position.set(12, WALL_H + 8);
    c.addChild(pill);
  }

  private addPerson(id: string, name: string, palette: { skin: string; hair: string; shirt: string }, tie: string, roomC: Container, room: Room, lx: number, ly: number, phase: number): Person {
    const p = new Person({ id, name, palette, tie, home: { x: roomC.x + lx, y: roomC.y + ly }, homeParent: roomC, homeIndex: 1, phase });
    this.people.set(id, p);
    this.colourOf.set(id, palette.shirt);
    void room;
    return p;
  }

  private drawManager(x: number, y: number, palette: { skin: string; hair: string; shirt: string }, handlers: OfficeHandlers): Person {
    const room = this.floor!.rooms.find((r) => r.kind === 'manager')!;
    const roomC = this.world.children.find((c) => c.x === room.x * TILE && c.y === room.y * TILE) as Container;
    const manager = this.addPerson('manager', this.floor!.names?.manager ?? 'Manager', palette, '#d8443c', roomC, room, desksIn(room)[0]!.x + 14, desksIn(room)[0]!.y - 44, 0);
    manager.root.eventMode = 'static';
    manager.root.cursor = 'pointer';
    manager.root.on('pointertap', (e) => {
      e.stopPropagation();
      if (this.gestured) return;
      handlers.onManager();
    });
    return manager;
  }

  // Which Claude sessions are running, by person id: busy ones type at their desk.
  // Short jobs (a few seconds) would blink past the 5 s check, so anyone seen
  // working keeps typing for 20 s after.
  private busyUntil = new Map<string, number>();
  private wasBusy = new Set<string>();
  showSessions(busy: Record<string, 'busy' | 'idle'>): void {
    const now = performance.now();
    for (const [id, state] of Object.entries(busy)) {
      if (state !== 'busy') continue;
      if (!this.wasBusy.has(id) && (this.busyUntil.get(id) ?? 0) < now) this.focus(id); // just started: go and look
      this.busyUntil.set(id, now + 20_000);
    }
    for (const [id, p] of this.people) {
      const was = p.typing;
      p.typing = (this.busyUntil.get(id) ?? 0) > now;
      if (was && !p.typing) this.sparkle(id); // finished
    }
    this.wasBusy = new Set(Object.entries(busy).filter(([, st]) => st === 'busy').map(([id]) => id));
    // Monitors are on wherever a session is running, working or waiting.
    for (const [id, screen] of this.screens) if (!screen.destroyed) screen.visible = id in busy;
    if (this.manager) this.manager.mood = (this.busyUntil.get('manager') ?? 0) > now ? 'working' : 'idle';
  }

  // A reply just came in: the camera visits, they type for a beat, then a "!" pops up over them.
  heard(id: string, text: string, at: string): void {
    if (this.bubbles?.isRead(id, text, at)) return this.update(id, text, at); // already read: no fuss
    this.busyUntil.set(id, Math.max(this.busyUntil.get(id) ?? 0, performance.now() + 2500));
    this.focus(id);
    setTimeout(() => this.update(id, text, at), 900);
  }

  // Pictures someone's latest message points at.
  pictures(id: string, at: string, n: number, load: (who: string, i: number) => Promise<string | undefined>): void {
    if (!this.bubbles) return;
    this.bubbles.loadPicture = load;
    this.bubbles.setPictures(id, at, n);
  }

  // Their latest message (a "!" over them until the owner reads it), without any fuss.
  update(id: string, text: string, at: string): void {
    const p = this.people.get(id);
    if (!p || !this.bubbles) return;
    this.bubbles.update(this.speaker(id, p), text, at);
  }

  // Someone sent a message to someone else on the floor (a room reporting to the manager,
  // The manager handing a room a job): they walk over saying it, their bubble following
  // them, wait a moment at the other desk, and walk back. Mid-walk already, or no
  // route: they just say it at their desk.
  deliver(fromId: string, toId: string, text: string, at: string): void {
    const from = this.people.get(fromId);
    const to = this.people.get(toId);
    const a = this.roomOf(fromId);
    const b = this.roomOf(toId);
    if (!from || !to || !a || !b || a === b || !this.hallway || from.walking) return this.heard(fromId, text, at);
    const hallway = this.hallway;
    // Still standing at someone else's desk from the last message: start from there.
    const here = this.away.get(fromId) ?? a;
    this.focus(toId);
    this.update(fromId, text, at);
    if (here === b) return; // already there
    from.walk(this.route(from.position, here, b, { x: to.home.x + 34, y: to.home.y + 18 }), hallway, () => {
      this.away.set(fromId, b);
      setTimeout(() => {
        // Off to someone else meanwhile: that trip brings them home.
        if (from.root.destroyed || from.walking || this.away.get(fromId) !== b) return;
        from.walkHome(this.route(from.position, b, a, { x: from.home.x, y: from.home.y + 6 }), hallway, () => this.away.delete(fromId));
      }, 2500);
    });
  }

  // A coffee break (src/team/coffee.ts): the rooms picked walk to the coffee room one after
  // another, each saying their line there, stay a while, then walk back.
  coffeeBreak(who: { id: string; line: string }[], at: string): void {
    const lounge = this.floor?.rooms.find((r) => r.kind === 'lounge');
    if (!lounge || !this.hallway) return;
    const hallway = this.hallway;
    this.focus(who[0]?.id ?? '');
    who.forEach((w, i) => {
      const p = this.people.get(w.id);
      const home = this.roomOf(w.id);
      if (!p || !home || p.walking) return this.update(w.id, w.line, at);
      const spot = { x: (lounge.x + 2 + i * 2.2) * TILE, y: (lounge.y + lounge.h - 1.6) * TILE };
      setTimeout(() => {
        if (p.root.destroyed || p.walking) return;
        p.walk(this.route(p.position, this.away.get(w.id) ?? home, lounge, spot), hallway, () => {
          this.away.set(w.id, lounge);
          this.update(w.id, `☕ ${w.line}`, at);
          setTimeout(() => {
            if (p.root.destroyed || p.walking || this.away.get(w.id) !== lounge) return;
            p.walkHome(this.route(p.position, lounge, home, { x: p.home.x, y: p.home.y + 6 }), hallway, () => this.away.delete(w.id));
          }, 25_000);
        });
      }, i * 2500);
    });
  }

  // Whose room: the manager's office, a project lead's room, or a staff member's (src/office/layout.ts STAFF).
  private roomOf(id: string): Room | undefined {
    return id === 'manager' ? this.floor?.rooms.find((r) => r.kind === 'manager') : this.floor?.rooms.find((r) => `lead:${r.id}` === id || r.staff?.id === id);
  }

  // A route through the corridors: out of the room's door, along the corridor
  // under its row, down the left-hand hallway if the rows differ, then along
  // the target's corridor and in through their door.
  private route(from: Point, fromRoom: Room, toRoom: Room, spot: Point): Point[] {
    const T = TILE;
    const door = (r: Room) => ({ x: (r.door?.x ?? r.x + r.w / 2) * T - 16, y: (r.door?.y ?? r.y + r.h) * T });
    const lane = (r: Room) => (r.corridorY ?? r.y + r.h + 0.5) * T;
    const inside = (r: Room) => ({ x: door(r).x, y: door(r).y - T * 1.4 });
    const pts: Point[] = [{ x: inside(fromRoom).x, y: from.y }, inside(fromRoom), door(fromRoom), { x: door(fromRoom).x, y: lane(fromRoom) - 16 }];
    if (lane(fromRoom) !== lane(toRoom)) pts.push({ x: T * 0.1, y: lane(fromRoom) - 16 }, { x: T * 0.1, y: lane(toRoom) - 16 });
    pts.push({ x: door(toRoom).x, y: lane(toRoom) - 16 }, door(toRoom), inside(toRoom), spot);
    return pts;
  }

  // The owner picked a model for someone: their badge changes at once.
  setModel(id: string, model: string): void {
    const old = this.pills.get(id);
    if (!old || old.destroyed || !old.parent) return;
    const pill = this.modelPill(model);
    pill.position.copyFrom(old.position);
    old.parent.addChild(pill);
    old.destroy({ children: true });
    this.pills.set(id, pill);
  }

  // A short passing line (a hello) that pops up and goes by itself.
  sayAs(id: string, text: string, ms?: number): void {
    const p = this.people.get(id);
    if (!p || !this.bubbles) return;
    this.bubbles.say(this.speaker(id, p), text, ms);
  }

  say(text: string, ms = 7000): void {
    this.sayAs('manager', text, ms);
  }

  // A whimsical happening over someone on the floor, only if nothing real is showing there.
  // Returns whether it was shown.
  // With it, maybe a prop beside them (for a few minutes) and a little move.
  happen(id: string, text: string, prop?: Prop, anim?: Anim, ms = 7000): boolean {
    const p = this.people.get(id);
    if (!p || !this.bubbles || !this.bubbles.isFree(id)) return false;
    this.bubbles.say(this.speaker(id, p), text, ms, true);
    if (p.walking) return true; // the line, but no props or moves mid-walk
    const at = p.position;
    if (prop) {
      this.props.get(id)?.g.destroy();
      // On the person, by their feet, so it goes where they go.
      const g = drawProp(prop);
      g.position.set(-10, 50);
      g.alpha = 0;
      p.root.addChild(g);
      this.props.set(id, { g, until: performance.now() + 3 * 60_000 });
    }
    if (anim === 'spin' || anim === 'hop') p.trick(anim);
    else if (anim) {
      const e = effect(anim, at.x, at.y);
      this.world.addChild(e.c);
      this.fx.push(e);
    }
    return true;
  }

  // Nothing real showing over them (see Bubbles.isFree).
  isFree(id: string): boolean {
    return !!this.bubbles?.isFree(id);
  }

  // Everyone on the floor now: id, first name, room name.
  cast(): { id: string; first: string; room: string }[] {
    return [...this.people].map(([id, p]) => { const s = this.speaker(id, p); return { id, first: s.name, room: s.role }; });
  }

  // Questions people need the owner to answer: a "?" over each one's head.
  showAsks(asks: Record<string, AskInfo>, answer: (askId: string, answer: Answer) => Promise<string | null>): void {
    if (!this.bubbles) return;
    this.bubbles.onAnswer = answer;
    for (const id of this.bubbles.askIds()) if (!asks[id]) this.bubbles.clearAsk(id);
    for (const [id, a] of Object.entries(asks)) {
      const p = this.people.get(id);
      if (p) this.bubbles.ask(this.speaker(id, p), a);
    }
  }

  // Whose session is stopped on a permission prompt (or its own question) in their room, and on what.
  // Returns who is newly stopped.
  showBlocked(blocked: Record<string, string>): string[] {
    if (!this.bubbles) return [];
    return this.bubbles.setBlocked(blocked, (id) => {
      const p = this.people.get(id);
      return p ? this.speaker(id, p) : undefined;
    });
  }

  // Whose session is running, and who is working right now (a "…" over them).
  keepBubbles(sessions: Record<string, 'busy' | 'idle'>): void {
    if (!this.bubbles) return;
    this.bubbles.setRunning(new Set(Object.keys(sessions)));
    const working: Speaker[] = [];
    for (const [id, st] of Object.entries(sessions)) {
      const p = this.people.get(id);
      if (st === 'busy' && p) working.push(this.speaker(id, p));
    }
    this.bubbles.setWorking(working);
  }

  private speaker(id: string, p: Person): Speaker {
    const room = id === 'manager' ? undefined : this.roomOf(id);
    return {
      id,
      name: id === 'manager' ? (this.floor?.names?.manager ?? 'Manager') : p.name.split(' ')[0]!,
      role: id === 'manager' ? 'Manager' : (room?.staff?.role ?? room?.name ?? ''),
      colour: this.colourOf.get(id) ?? '#3f6fb5',
      anchor: () => {
        if (p.root.destroyed) return null;
        const g = p.root.getGlobalPosition();
        const s = this.world.scale.x;
        return { x: g.x + 18 * s, y: g.y + 4 * s, foot: g.y + 46 * s };
      },
    };
  }

  // A little burst of sparkles over someone who just finished a job.
  private sparkle(id: string): void {
    const p = this.people.get(id);
    if (!p) return;
    const at = p.position;
    const colours = [0xf2b544, 0xfdfaf3, 0x7fd1ff, 0xe08a5b];
    for (let i = 0; i < 10; i++) {
      const g = new PIXI.Graphics().rect(-2, -2, 4, 4).fill(colours[i % colours.length]!);
      g.position.set(at.x + 18, at.y + 12);
      g.rotation = Math.PI / 4;
      const a = (i / 10) * Math.PI * 2;
      this.world.addChild(g);
      this.sparks.push({ g, vx: Math.cos(a) * 70, vy: Math.sin(a) * 70 - 40, life: 700 });
    }
  }

  // Glide to someone's room at a readable zoom, hold, then drift back to the whole floor.
  focus(id: string): void {
    if (!this.floor || performance.now() - this.lastTouch < 12_000) return;
    const room = this.roomOf(id);
    if (!room) return;
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    // Big enough to read, small enough that the room and its neighbours show.
    const s = Math.min(1.3, Math.max(this.fitScale * 1.5, Math.min(sw / ((room.w + 8) * TILE), sh / ((room.h + 7) * TILE))));
    if (s <= this.fitScale * 1.05) return; // the whole floor is already this big
    const cx = (room.x + room.w / 2) * TILE;
    const cy = (room.y + room.h / 2) * TILE;
    this.cam = { x: sw / 2 - cx * s, y: sh / 2 - cy * s, s, until: performance.now() + 9000 };
  }

  private animate(dt: number): void {
    this.t += dt;
    for (const p of this.people.values()) p.tick(dt, this.t);
    // Sparkles fly out and fade.
    this.sparks = this.sparks.filter((sp) => {
      sp.life -= dt;
      if (sp.life <= 0 || sp.g.destroyed) {
        if (!sp.g.destroyed) sp.g.destroy();
        return false;
      }
      sp.g.x += (sp.vx * dt) / 1000;
      sp.g.y += (sp.vy * dt) / 1000;
      sp.vy += (160 * dt) / 1000;
      sp.g.alpha = sp.life / 700;
      return true;
    });
    // Happenings: moves play out; props fade in, stay a few minutes, fade out.
    this.fx = this.fx.filter((e) => {
      e.t += dt;
      if (e.t >= e.ms || e.c.destroyed) {
        if (!e.c.destroyed) e.c.destroy({ children: true });
        return false;
      }
      e.step(e.t / e.ms);
      return true;
    });
    const now = performance.now();
    for (const [id, pr] of this.props) {
      if (pr.g.destroyed) this.props.delete(id);
      else if (now > pr.until) {
        pr.g.alpha -= dt / 600;
        if (pr.g.alpha <= 0) {
          pr.g.destroy();
          this.props.delete(id);
        }
      } else if (pr.g.alpha < 1) pr.g.alpha = Math.min(1, pr.g.alpha + dt / 400);
    }
    // The camera eases towards its target; after the hold, back to the whole floor.
    if (this.cam && this.floor) {
      if (performance.now() - this.lastTouch < 12_000) this.cam = null;
      else {
        const done = performance.now() > this.cam.until;
        const t = done ? this.fitView() : this.cam;
        const k = Math.min(1, dt / 450);
        const s = this.world.scale.x + (t.s - this.world.scale.x) * k;
        this.world.scale.set(s);
        this.world.position.set(this.world.x + (t.x - this.world.x) * k, this.world.y + (t.y - this.world.y) * k);
        if (done && Math.abs(s - t.s) < 0.002) {
          this.cam = null;
          this.fit();
        }
      }
    }
    this.bubbles?.tick(dt);
  }

  // Where fit() puts the camera, without moving it.
  private fitView(): { x: number; y: number; s: number } {
    const W = this.floor!.width * TILE;
    const H = this.floor!.height * TILE;
    const s = Math.min(this.app.screen.width / (W + 40), this.app.screen.height / (H + 40), 1.4);
    return { x: (this.app.screen.width - W * s) / 2, y: (this.app.screen.height - H * s) / 2, s };
  }

  // The floor's space changed (terminal opened, dragged or closed): resize and refit.
  relayout(): void {
    this.app.resize();
    this.fit();
  }

  // Fit the whole floor in view.
  fit(): void {
    if (!this.floor) return;
    const W = this.floor.width * TILE;
    const H = this.floor.height * TILE;
    const s = Math.min(this.app.screen.width / (W + 40), this.app.screen.height / (H + 40), 1.4);
    this.world.scale.set(s);
    this.fitScale = s;
    this.world.position.set((this.app.screen.width - W * s) / 2, (this.app.screen.height - H * s) / 2);
    // The current zoom, readable from the page (handy for checks; no data in it).
    (this.app.canvas.parentElement as HTMLElement | null)?.setAttribute('data-zoom', s.toFixed(2));
  }

  // True from the moment a drag or pinch moves until the next touch, so lifting
  // a finger after panning doesn't also open the room under it.
  private gestured = false;
  private fitScale = 1; // zoom that shows the whole floor; zooming out can always get back to it

  // Mouse: drag to pan, wheel to zoom. Touch: one finger pans, two fingers
  // pinch-zoom around the point between them, double-tap fits the floor again.
  private enablePanZoom(host: HTMLElement, handlers: OfficeHandlers): void {
    const MAX = 2.5;
    const min = () => Math.min(0.25, this.fitScale);
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; wx: number; wy: number } | null = null;
    let pinch: { dist: number; scale: number; worldX: number; worldY: number } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    const local = (p: { x: number; y: number }) => {
      const r = host.getBoundingClientRect();
      return { x: p.x - r.left, y: p.y - r.top };
    };
    const startDrag = (p: { x: number; y: number }) => (drag = { x: p.x, y: p.y, wx: this.world.x, wy: this.world.y });
    const startPinch = () => {
      const [a, b] = [...pointers.values()];
      const mid = local({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 });
      const s = this.world.scale.x;
      // The floor point under the fingers stays under them while zooming.
      pinch = { dist: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), scale: s, worldX: (mid.x - this.world.x) / s, worldY: (mid.y - this.world.y) / s };
      drag = null;
    };
    host.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
      if (!pointers.size) this.gestured = false;
      this.lastTouch = performance.now();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) startDrag({ x: e.clientX, y: e.clientY });
      else if (pointers.size === 2) startPinch();
    });
    window.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const mid = local({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 });
        const next = Math.min(MAX, Math.max(min(), (pinch.scale * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.dist));
        this.world.scale.set(next);
        this.world.position.set(mid.x - pinch.worldX * next, mid.y - pinch.worldY * next);
        host.dataset.zoom = next.toFixed(2);
        this.gestured = true;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.gestured = true;
      this.world.position.set(drag.wx + dx, drag.wy + dy);
    });
    const lift = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size < 2) pinch = null;
      // A third finger was down: measure the two that remain from here, no jump.
      else if (pinch) startPinch();
      // One finger left after a pinch: carry on panning from where it is, no jump.
      if (pointers.size === 1) startDrag([...pointers.values()][0]!);
      if (pointers.size === 0) {
        drag = null;
        if (e.pointerType === 'touch' && !this.gestured) {
          const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
          if (near && e.timeStamp - lastTap.t < 300) {
            this.fit();
            lastTap = { t: 0, x: 0, y: 0 };
          } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
        }
      }
    };
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointertap', () => {
      if (this.gestured) return;
      this.bubbles?.close(); // tapping the empty floor closes an open bubble
      handlers.onEmpty();
    });
    host.addEventListener(
      'wheel',
      (e) => {
        // Only over the floor itself: the whiteboard, timetable and cards scroll as usual.
        if ((e.target as HTMLElement).tagName !== 'CANVAS') return;
        e.preventDefault();
        this.lastTouch = performance.now();
        this.cam = null;
        const rect = host.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const old = this.world.scale.x;
        const next = Math.min(MAX, Math.max(min(), old * (e.deltaY < 0 ? 1.1 : 0.9)));
        this.world.scale.set(next);
        this.world.position.set(mx - ((mx - this.world.x) * next) / old, my - ((my - this.world.y) * next) / old);
        host.dataset.zoom = next.toFixed(2);
      },
      { passive: false },
    );
  }
}// Model pill colours.
const MODEL_COLOURS: Record<string, number> = { opus: 0xe08a5b, sonnet: 0x7fb8a4, haiku: 0xf2b544 };
