import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

// A folder the owner archived stays in the cupboard, however busy it gets.
test('archived folders stay in the archive cupboard however busy they are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ archivedProjects: ['/Users/g/Dev/old-prototype', 'not a path'] }));
  assert.deepEqual(loadConfig(path).archivedProjects, ['/Users/g/Dev/old-prototype']);
  // Guard: the floor puts them after every other project and never gives them a room.
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  assert.match(main, /config\.archivedProjects\.includes/);
  assert.match(main, /layoutFloor\(projects, Date\.now\(\), \{ leads, onFloor[,}]/);
  assert.match(main, /staffRooms\(projects\.slice\(0, onFloor\)/);
});
