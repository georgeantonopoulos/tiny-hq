import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extraRoomSessions, ownStatus, serversOnly, type BackgroundSession } from '../src/terminal/sessions.ts';
import { renderStatus } from '../src/terminal/status.ts';

test('a session kept "busy" only by background servers it left running reads idle, and the status page lists it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'th-servers-'));
  writeFileSync(join(dir, '3941.json'), JSON.stringify({ pid: 3941, status: 'shell' }));
  writeFileSync(join(dir, '3940.json'), JSON.stringify({ pid: 3940, status: 'busy' }));
  assert.equal(ownStatus(3941, dir), 'shell');
  assert.equal(ownStatus(9999, dir), undefined);

  const atlas: BackgroundSession = { id: '15db9267', sessionId: 's', cwd: '/r/atlas', pid: 3941, status: 'busy', state: 'done' };
  const idle = serversOnly(atlas, ownStatus(3941, dir));
  assert.equal(idle.status, 'idle');
  assert.equal(idle.servers, true);
  // A session mid-turn stays busy.
  const working = { ...atlas, pid: 3940, state: 'working' };
  assert.equal(serversOnly(working, ownStatus(3940, dir)).status, 'busy');
  assert.equal(serversOnly(working, undefined).status, 'busy');
  // A new turn starting before Claude Code's own file catches up: still busy.
  assert.equal(serversOnly(working, 'shell').status, 'busy');
  // An older session with servers left running is never retired as an extra (stopping it would kill them).
  const room = '/r/atlas';
  const old = { ...idle, realCwd: room, startedAt: 1 };
  const fresh = { ...atlas, id: 'n', status: 'idle', realCwd: room, startedAt: 2 };
  assert.deepEqual(extraRoomSessions([old, fresh], room), []);

  const page = renderStatus([{ id: '15db9267', name: 'Atlas', status: 'idle', servers: true, state: 'done', alive: true, room: 'Atlas' }], ['Atlas']);
  assert.match(page, /\(15db9267\): idle, servers left running/);
  assert.match(page, /## Servers left running[^\n]*\n- Atlas \(15db9267\) in Atlas/);
  // Nothing left running: no section.
  assert.doesNotMatch(renderStatus([{ id: 'a', status: 'idle', alive: true, room: 'X' }], ['X']), /Servers left running/);
});
