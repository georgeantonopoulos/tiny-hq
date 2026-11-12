// The office decor, read from ~/.tiny-hq/scene.json: moved or resized
// rooms, extra rooms, colours, and objects (paintings, plants, rugs, lamps...).
// The floor plan is generated from the owner's projects; the decor sits on top.

import { existsSync, readFileSync } from 'node:fs';
import type { Floor, Room } from './layout.ts';

export const OBJECT_KINDS = ['painting', 'plant', 'poster', 'rug', 'lamp', 'sofa', 'bookshelf', 'watercooler', 'whiteboard', 'sign', 'table', 'window', 'trophy'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

export interface SceneObject {
  id: string;
  kind: ObjectKind;
  room: string; // room id it belongs to
  x: number; // tiles from the room's top-left
  y: number;
  w: number;
  h: number;
  colour?: string;
  label?: string;
  // Paintings and posters: original pixel art, rows of palette letters.
  pixels?: string[];
  palette?: Record<string, string>;
}

export interface RoomStyle {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  name?: string;
  floor?: string;
  wall?: string;
}

export interface BuiltRoom {
  id: string; // 'custom:<slug>'
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  floor?: string;
  wall?: string;
}

export interface Scene {
  version: 1;
  theme: { corridor?: string; wall?: string; background?: string };
  rooms: Record<string, RoomStyle>;
  built: BuiltRoom[];
  objects: SceneObject[];
}

export const EMPTY_SCENE: Scene = { version: 1, theme: {}, rooms: {}, built: [], objects: [] };

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function loadScene(path: string): Scene {
  if (!existsSync(path)) return structuredClone(EMPTY_SCENE);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Scene>;
    return {
      version: 1,
      theme: raw.theme && typeof raw.theme === 'object' ? raw.theme : {},
      rooms: raw.rooms && typeof raw.rooms === 'object' ? raw.rooms : {},
      built: Array.isArray(raw.built) ? raw.built : [],
      objects: Array.isArray(raw.objects) ? raw.objects : [],
    };
  } catch {
    return structuredClone(EMPTY_SCENE);
  }
}

// Applies the scene to the generated floor plan. Anything that no longer fits
// (e.g. a moved room now overlaps a new project room) is skipped, not forced.
export function applyScene(floor: Floor, scene: Scene): Floor & { objects: SceneObject[]; theme: Scene['theme'] } {
  // Every move is tried at once, then any room that clashes with another's
  // final spot goes back to where it was (repeated until nothing clashes), so
  // the result doesn't depend on which room is listed first.
  const rooms: Room[] = floor.rooms.map((r) => {
    const s = scene.rooms[r.id];
    if (!s) return { ...r };
    return { ...r, ...(s.x !== undefined ? { x: s.x } : {}), ...(s.y !== undefined ? { y: s.y } : {}), ...(s.w !== undefined ? { w: s.w } : {}), ...(s.h !== undefined ? { h: s.h } : {}) };
  });
  for (let changed = true; changed; ) {
    changed = false;
    rooms.forEach((r, i) => {
      const orig = floor.rooms[i]!;
      const moved = r.x !== orig.x || r.y !== orig.y || r.w !== orig.w || r.h !== orig.h;
      if (moved && rooms.some((o) => o !== r && overlaps(o, r))) {
        Object.assign(r, { x: orig.x, y: orig.y, w: orig.w, h: orig.h });
        changed = true;
      }
    });
  }
  rooms.forEach((r, i) => {
    const s = scene.rooms[r.id];
    if (!s) return;
    const orig = floor.rooms[i]!;
    if (s.name) r.name = s.name;
    if (s.floor || s.wall) r.style = { ...r.style, ...(s.floor ? { floor: s.floor } : {}), ...(s.wall ? { wall: s.wall } : {}) };
    if (r.x !== orig.x || r.y !== orig.y || r.h !== orig.h || r.w !== orig.w) {
      r.door = { x: r.x + r.w / 2, y: r.y + r.h };
      r.corridorY = r.y + r.h + 0.5;
    }
  });
  // People sitting in a moved room move with it (The manager is drawn from these).
  const agents = floor.agents.map((a) => {
    const i = floor.rooms.findIndex((r) => r.id === a.roomId);
    if (i < 0) return a;
    return { ...a, x: a.x + rooms[i]!.x - floor.rooms[i]!.x, y: a.y + rooms[i]!.y - floor.rooms[i]!.y };
  });
  for (const b of scene.built) {
    const room: Room = { id: b.id, kind: 'custom', name: b.name, x: b.x, y: b.y, w: b.w, h: b.h, style: { ...(b.floor ? { floor: b.floor } : {}), ...(b.wall ? { wall: b.wall } : {}) } };
    if (rooms.some((o) => overlaps(o, room))) continue;
    room.door = { x: b.x + b.w / 2, y: b.y + b.h };
    room.corridorY = b.y + b.h + 0.5;
    rooms.push(room);
  }
  const ids = new Set(rooms.map((r) => r.id));
  const objects = scene.objects.filter((o) => ids.has(o.room));
  const width = Math.max(floor.width, ...rooms.map((r) => r.x + r.w + 1));
  const height = Math.max(floor.height, ...rooms.map((r) => r.y + r.h + 2));
  return { ...floor, rooms, agents, width, height, objects, theme: scene.theme };
}
