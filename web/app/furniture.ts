// Where the fixed desks sit in each kind of room, in pixels from the room's top-left.

export const TILE = 32;

export interface Desk {
  who: string; // whose desk
  x: number; // desk top-left, pixels within the room
  y: number;
}

export function desksIn(room: { kind: string; w: number; h: number; lead?: { name: string } }): Desk[] {
  const bottom = room.h * TILE;
  switch (room.kind) {
    case 'project':
    case 'staff':
    case 'desk':
      return [{ who: room.lead?.name ?? 'the lead', x: (room.w * TILE) / 2 - TILE, y: bottom - TILE * 2.4 }];
    case 'manager':
      return [{ who: 'Manager', x: 3 * TILE - 20, y: 4 * TILE + 26 }];
    default:
      return [];
  }
}
