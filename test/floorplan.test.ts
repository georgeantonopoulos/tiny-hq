import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProjects, type SourceHit } from '../src/discovery/scan.ts';
import { layoutFloor, type Floor } from '../src/office/layout.ts';
import { applyScene, EMPTY_SCENE, type Scene } from '../src/office/scene.ts';
import { buildFloorPlan } from '../web/app/floorplan.ts';

const HOME = '/Users/test';
const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 86_400_000;

function makeFloor(projectCount: number): Floor {
  const hits: SourceHit[] = Array.from({ length: projectCount }, (_, i) => ({
    kind: 'claude' as const,
    path: `/Users/test/Dev/proj-${i}`,
    sessions: Math.max(1, projectCount - i) * 3,
    recentSessions: Math.max(1, projectCount - i) * 2,
    lastActive: NOW - i * DAY,
  }));
  return layoutFloor(mergeProjects(hits, NOW, HOME), NOW);
}

function assertFloorPlanInvariants(floor: Floor, label: string): ReturnType<typeof buildFloorPlan> {
  const plan = buildFloorPlan(floor);
  assert.equal(plan.width, floor.width, `${label}: width`);
  assert.equal(plan.height, floor.height, `${label}: height`);

  // Every pocket tile must be assigned to a zone (zero deadzones left over).
  for (let y = 0; y < plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (plan.grid[y]![x] === 'pocket') {
        assert.ok(plan.zoneAt[y]![x] !== null, `${label}: uncovered pocket tile at (${x}, ${y})`);
      } else {
        assert.equal(plan.zoneAt[y]![x], null, `${label}: non-pocket tile (${x}, ${y}) has zone`);
      }
    }
  }

  // Zones must stay within bounds and never overlap rooms or each other.
  for (let i = 0; i < plan.zones.length; i++) {
    const a = plan.zones[i]!;
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= plan.width && a.y + a.h <= plan.height, `${label}: zone ${a.id} out of bounds`);
    for (const r of floor.rooms) {
      const overlaps = a.x < r.x + r.w && r.x < a.x + a.w && a.y < r.y + r.h && r.y < a.y + a.h;
      assert.equal(overlaps, false, `${label}: zone ${a.id} overlaps room ${r.id}`);
    }
    for (let j = i + 1; j < plan.zones.length; j++) {
      const b = plan.zones[j]!;
      const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlaps, false, `${label}: zone ${a.id} overlaps ${b.id}`);
    }
  }

  // Every walking room's doorway drop path, corridor lane, and left spine must be unobstructed ('hall').
  const laneRows: number[] = [];
  for (const r of floor.rooms) {
    const dx = r.door?.x ?? r.x + r.w / 2;
    const dy = Math.floor(r.door?.y ?? r.y + r.h);
    const cy = Math.floor(r.corridorY ?? dy + 0.5);
    laneRows.push(cy);
    for (let y = dy; y <= cy; y++) {
      for (let x = Math.floor(dx - 0.5); x <= Math.floor(dx + 0.49); x++) {
        assert.equal(plan.grid[y]![x], 'hall', `${label}: door path for ${r.id} blocked at (${x}, ${y})`);
        assert.equal(plan.zoneAt[y]![x], null, `${label}: zone on door path for ${r.id} at (${x}, ${y})`);
      }
    }
    // Horizontal lane from left spine (x=0) to door must be clear.
    for (let x = 0; x <= Math.floor(dx + 0.49); x++) {
      assert.equal(plan.grid[cy]![x], 'hall', `${label}: corridor lane blocked at (${x}, ${cy})`);
      assert.equal(plan.runner[cy]![x], true, `${label}: runner missing on lane at (${x}, ${cy})`);
    }
  }
  const minLane = Math.min(...laneRows);
  const maxLane = Math.max(...laneRows);
  for (let y = minLane; y <= maxLane; y++) {
    assert.equal(plan.grid[y]![0], 'hall', `${label}: left spine blocked at (0, ${y})`);
    assert.equal(plan.runner[y]![0], true, `${label}: left spine runner missing at (0, ${y})`);
  }

  return plan;
}

test('floorplan: invariants hold for 0, 3, 7, 12, and 20 projects (with archive)', () => {
  for (const count of [0, 3, 7, 12, 20]) {
    const floor = makeFloor(count);
    assertFloorPlanInvariants(floor, `${count} projects`);
  }
});

test('floorplan: full 12-project office produces diverse zones and is deterministic', () => {
  const floor = makeFloor(18);
  const a = assertFloorPlanInvariants(floor, 'full-a');
  const b = buildFloorPlan(floor);
  assert.deepEqual(a.zones, b.zones, 'deterministic zone generation');
  assert.deepEqual(a.grid, b.grid, 'deterministic tile grid');
  const kinds = new Set(a.zones.map((z) => z.kind));
  assert.ok(kinds.size >= 4, `expected diverse zone kinds, got: ${[...kinds].join(', ')}`);
});

test('floorplan: adapts procedurally to moved, resized, and custom rooms via applyScene', () => {
  const base = makeFloor(8);
  const scene: Scene = {
    ...structuredClone(EMPTY_SCENE),
    rooms: {
      manager: { w: 10, h: 7 },
    },
    built: [
      { id: 'custom:war-room', name: 'War room', x: 2, y: base.height, w: 8, h: 5 },
    ],
  };
  const modified = applyScene(base, scene);
  const plan = assertFloorPlanInvariants(modified, 'custom-scene');
  assert.ok(plan.doorways.some((d) => d.roomId === 'custom:war-room'), 'custom room gets a doorway');
});
