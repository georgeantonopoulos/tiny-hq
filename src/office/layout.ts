// Turns the project list into an office floor plan (tile units). Pure and
// deterministic: the browser only draws what this returns.

import type { Project } from '../discovery/scan.ts';
import type { Leads, Palette } from '../team/leads.ts';

export interface Room {
  id: string;
  kind: 'manager' | 'project' | 'archive' | 'custom' | 'lounge' | 'staff' | 'desk';
  style?: { floor?: string; wall?: string }; // colours from the saved decor
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  project?: {
    path: string;
    lastActive: number;
    sessions: number;
    recentSessions: number;
    activity: number;
    sources: string[];
    remote?: string;
    language?: string;
  };
  count?: number; // archive: how many quieter projects are filed here
  lead?: { name: string; personality: string; palette: Palette };
  staff?: { id: string; name: string; role: string; palette: { skin: string; hair: string; shirt: string } }; // staff room: who works there
  model?: string; // project: the model the owner picked for this room's Claude (absent: their default)
  // Walking routes: the doorway in the bottom wall, and the corridor just below this room's row.
  door?: { x: number; y: number };
  corridorY?: number;
}

// Office staff: people on the floor with a standing job and no project folder. Each gets a small
// room of their own in the top row and a desk; the page draws them from this list alone, and the
// daemon fills their bubble (said) and busy light (sessions) under the same id.
export interface Staff {
  id: string;
  name: string;
  role: string; // shown under the room name
  room: string; // the room's name on the door
  palette: { skin: string; hair: string; shirt: string };
}
export const STAFF: Staff[] = [
  // The GitHub keeper: watches all the owner's GitHub, on Sonnet, reporting to the manager (src/team/github.ts).
  { id: 'otto', name: 'Otto', role: 'GitHub keeper · Sonnet', room: 'GitHub desk', palette: { skin: '#c98e6b', hair: '#2b2b2b', shirt: '#24292f' } },
];

export interface Agent {
  id: string;
  name: string;
  role: string;
  roomId: string;
  x: number; // tile coordinates of the desk
  y: number;
  palette: { skin: string; hair: string; shirt: string };
}

export interface Floor {
  width: number;
  height: number;
  door: { x: number; y: number };
  rooms: Room[];
  agents: Agent[];
  generatedAt: number;
  names?: { manager: string; owner: string; office?: string }; // from the owner's settings, for the page
}

export const MAX_ROOMS = 12;

const COLS = 4;
const GAP = 1; // corridor width between rooms

// Room size grows with activity, relative to the other rooms on show, so the
// busiest project always gets the biggest room.
function sizeFor(activity: number, min: number, max: number): { w: number; h: number } {
  const t = max > min ? (activity - min) / (max - min) : 1;
  return { w: 6 + Math.round(4 * t), h: 5 + Math.round(3 * t) };
}

export function layoutFloor(
  projects: Project[],
  now = Date.now(),
  extras: {
    leads?: Leads;
    onFloor?: number; // how many projects get rooms (the rest are archived); default MAX_ROOMS
    managerName?: string; // the name the owner gave the manager (settings)
    ownerName?: string; // the owner's name (settings)
    officeName?: string; // the office's name (settings)
    github?: boolean; // the GitHub keeper is switched on (settings): Otto's room is on the floor
    coffee?: boolean; // the coffee room is switched on (settings)
  } = {},
): Floor {
  const shown = projects.slice(0, Math.min(MAX_ROOMS, extras.onFloor ?? MAX_ROOMS));
  const rest = projects.length - shown.length;

  const rooms: Room[] = [];
  const acts = shown.map((p) => p.activity);
  const lo = Math.min(...acts);
  const hi = Math.max(...acts);
  const cells = shown.map((p) => ({ p, ...sizeFor(p.activity, lo, hi) }));
  const rows: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += COLS) rows.push(cells.slice(i, i + COLS));
  const colW = Array.from({ length: COLS }, (_, c) => Math.max(6, ...rows.map((r) => r[c]?.w ?? 0)));
  const width = GAP + colW.reduce((a, b) => a + b + GAP, 0);

  // Top row: the archive cupboard, then the manager's office by the front door.
  const archive: Room | undefined =
    rest > 0 ? { id: 'archive', kind: 'archive', name: 'Archive cupboard', x: GAP, y: GAP, w: 6, h: 5, count: rest } : undefined;
  const manager: Room = { id: 'manager', kind: 'manager', name: `${extras.managerName ?? 'Manager'}'s office`, x: GAP + (archive ? 6 + GAP : 0), y: GAP, w: 12, h: 8 };
  rooms.push(manager);
  if (archive) rooms.push(archive);
  // Staff rooms next to the manager's office.
  let staffX = manager.x + manager.w + GAP;
  const staffRooms = STAFF.filter((st) => st.id !== 'otto' || extras.github !== false).map((st) => {
    const r: Room = { id: `staff:${st.id}`, kind: 'staff', name: st.room, x: staffX, y: GAP, w: 7, h: 6, staff: { id: st.id, name: st.name, role: st.role, palette: st.palette } };
    staffX += r.w + GAP;
    return r;
  });
  rooms.push(...staffRooms);
  // The owner's own desk, where reports they asked for wait for them (src/team/desk.ts).
  const ownerDesk: Room = { id: 'desk', kind: 'desk', name: 'Your desk', x: staffX, y: GAP, w: 6, h: 6 };
  rooms.push(ownerDesk);
  staffX += ownerDesk.w + GAP;
  // The coffee room: top right, where everyone can get together. No project, no session.
  const lounge: Room | undefined = extras.coffee === false ? undefined : { id: 'lounge', kind: 'lounge', name: 'Coffee room', x: Math.max(staffX, width - GAP - 9), y: GAP, w: 9, h: 6 };
  if (lounge) rooms.push(lounge);

  // The corridor under the top row runs between it and the first project row.
  const topBottom = Math.max(...rooms.map((r) => r.y + r.h));
  for (const r of rooms) {
    r.door = { x: r.x + r.w / 2, y: r.y + r.h };
    r.corridorY = topBottom + 0.5;
  }

  let y = manager.y + manager.h + GAP + 1;
  for (const row of rows) {
    let x = GAP;
    const rowH = Math.max(...row.map((c) => c.h));
    row.forEach((c, i) => {
      const p = c.p;
      const git = p.sources.git;
      const lead = extras.leads?.[p.path];
      rooms.push({
        id: p.id,
        kind: 'project',
        name: p.name,
        x,
        y,
        w: c.w,
        h: c.h,
        project: {
          path: p.path,
          lastActive: p.lastActive,
          sessions: p.sessions,
          recentSessions: p.recentSessions,
          activity: p.activity,
          sources: Object.keys(p.sources),
          ...(git?.remote ? { remote: git.remote } : {}),
          ...(git?.language ? { language: git.language } : {}),
        },
        ...(lead ? { lead: { name: lead.name, personality: lead.personality, palette: lead.palette } } : {}),
        door: { x: x + c.w / 2, y: y + c.h },
        corridorY: y + rowH + GAP / 2,
      });
      x += (colW[i] ?? c.w) + GAP;
    });
    y += rowH + GAP;
  }

  const agents: Agent[] = [
    {
      id: 'manager',
      name: extras.managerName ?? 'Manager',
      role: 'Manager',
      roomId: 'manager',
      x: manager.x + 3,
      y: manager.y + 4,
      palette: { skin: '#e8b48f', hair: '#6b4a2f', shirt: '#3f6fb5' },
    },
  ];

  const right = Math.max(...rooms.map((r) => r.x + r.w));
  return { width: Math.max(width, right + GAP), height: y + 2, door: { x: manager.x + 5, y: 0 }, rooms, agents, generatedAt: now, names: { manager: extras.managerName ?? 'Manager', owner: extras.ownerName ?? 'Owner', office: extras.officeName ?? 'Tiny HQ' } };
}
