// Little happenings on the floor, to keep morale up: the office should be fun to look at. Every few
// minutes one person's corner of the office does something silly: told by a narrator in
// italics, never over someone with a question, an unread message or work under way, so it
// never hides real status. Nothing here is real news and nothing is sent anywhere.

// {name}: their first name; {room}: their room.
export const HAPPENINGS: readonly string[] = [
  "{name}'s plant has asked, politely, what the goal is.",
  "{name}'s desk lamp flickered in solidarity.",
  '{name} and the coffee machine are holding a stand-up. The coffee machine has blockers.',
  "{room}'s window reports: still a window.",
  "{name}'s chair did a full spin. Nobody admits to it.",
  "A sticky note on {name}'s screen just says 'yes'. To what is unclear.",
  "{room}'s rug is quietly proud of its pattern.",
  '{name} named the stapler. It is now called Kevin.',
  "{name}'s plant leaned toward the window. Growth mindset.",
  "{room} has a new rumour: the printer used to be in a band.",
  "{name}'s keyboard is out of 'e's. Morale remains xcllnt.",
  "{name} found a biscuit behind the monitor from last quarter.",
  '{name} waved at the camera. The camera waved back. Unsettling.',
  "{room}'s clock is five minutes fast, on purpose, for motivation.",
];

export const MANAGER_HAPPENINGS: readonly string[] = [
  'The whiteboard is sulking after the tidy. The Manager offered it a marker.',
  'The Manager straightened the whiteboard. It straightened back.',
  'The Manager is meditating at their desk. The inbox is not.',
  'The archive cupboard hummed a little tune. The Manager hummed back.',
  'The Manager has scheduled a meeting about the meeting. Attendance: the plant.',
  'The Manager whispered "synergy" to the coffee machine. It gurgled.',
];

// The kit a happening can use besides its line (new gags, props and a
// few stock animations, written by a Haiku agent now and then). The props and moves are drawn
// by the office; the writer only picks from these names, so nothing it writes ever runs.
export const PROPS = ['duck', 'cake', 'balloon', 'cactus', 'pizza', 'mug', 'trophy', 'discoball', 'banana', 'papers'] as const;
export const ANIMS = ['spin', 'hop', 'plane', 'cat', 'confetti', 'zzz', 'notes', 'rain'] as const;
export type Prop = (typeof PROPS)[number];
export type Anim = (typeof ANIMS)[number];

// A written happening. `who`: 'anyone' lines use {name}/{room}; 'manager' lines are about "The Manager", shown as the manager's own name.
export interface Gag {
  text: string;
  who: 'anyone' | 'manager';
  prop?: Prop;
  anim?: Anim;
}

// A gag from outside (the writer's file): kept only if it's a short plain line using the kit.
export function validGag(x: unknown): Gag | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
  if (text.length < 12 || text.length > 140 || /[<>`]|https?:|www\.|@|\bboss\b/i.test(text)) return undefined; // never "boss"
  const who = o.who === 'manager' ? 'manager' : 'anyone';
  if (who === 'anyone' && !/\{name\}|\{room\}/.test(text)) return undefined;
  if (who === 'manager' && !/The Manager/.test(text)) return undefined;
  // Only the two placeholders; any other {braces} would show up raw.
  if (/\{(?!name\}|room\})/.test(text)) return undefined;
  const g: Gag = { text, who };
  if (o.prop !== undefined && o.prop !== null) {
    if (!(PROPS as readonly unknown[]).includes(o.prop)) return undefined;
    g.prop = o.prop as Prop;
  }
  if (o.anim !== undefined && o.anim !== null) {
    if (!(ANIMS as readonly unknown[]).includes(o.anim)) return undefined;
    g.anim = o.anim as Anim;
  }
  return g;
}

export interface Cast {
  id: string;
  first: string;
  room: string;
}

export function pick<T>(list: readonly T[], rnd: () => number = Math.random): T {
  return list[Math.floor(rnd() * list.length) % list.length]!;
}

export function fill(line: string, who: Cast): string {
  return line.replaceAll('{name}', who.first || 'Someone').replaceAll('{room}', who.room || 'The office').replaceAll('The Manager', who.id === 'manager' && who.first ? who.first : 'The Manager');
}

export interface Happening {
  id: string;
  text: string;
  prop?: Prop;
  anim?: Anim;
}

// The next happening: who, and what. Tries a few people; none free means none this time.
// Written gags (`gags`) come up about two times in three once there are some.
export function nextHappening(cast: Cast[], isFree: (id: string) => boolean, rnd: () => number = Math.random, gags: readonly Gag[] = []): Happening | undefined {
  const free = cast.filter((c) => isFree(c.id));
  if (!free.length) return undefined;
  const who = pick(free, rnd);
  const manager = who.id === 'manager';
  const mine = gags.filter((g) => (g.who === 'manager') === manager);
  if (mine.length && rnd() < 0.66) {
    const g = pick(mine, rnd);
    return { id: who.id, text: fill(g.text, who), ...(g.prop ? { prop: g.prop } : {}), ...(g.anim ? { anim: g.anim } : {}) };
  }
  return { id: who.id, text: fill(pick(manager ? MANAGER_HAPPENINGS : HAPPENINGS, rnd), who) };
}

// Every 3 to 6 minutes while the page is in front of the owner.
export function startHappenings(o: { cast: () => Cast[]; happen: (h: Happening) => boolean; isFree: (id: string) => boolean; gags?: () => readonly Gag[] }): void {
  const next = () => setTimeout(tick, (3 + Math.random() * 3) * 60_000);
  const tick = () => {
    if (!document.hidden) {
      const h = nextHappening(o.cast(), o.isFree, Math.random, o.gags?.() ?? []);
      if (h) o.happen(h);
    }
    next();
  };
  next();
}
