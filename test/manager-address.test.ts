import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managerAddress } from '../src/terminal/sessions.ts';

// A `claude agents` id isn't something SendMessage resolves, so rooms would ask the owner which
// manager to use. The address is the manager's socket, which SendMessage takes as-is.
test("The manager's address is their live socket, or plain the manager when there's none", () => {
  const dir = mkdtempSync(join(tmpdir(), 'socks-'));
  writeFileSync(join(dir, '3322.sock'), '');
  assert.equal(managerAddress(3322, dir), `uds:${join(dir, '3322.sock')}`);
  assert.equal(managerAddress(9999, dir), 'Manager');
  assert.equal(managerAddress(undefined, dir), 'Manager');
});
