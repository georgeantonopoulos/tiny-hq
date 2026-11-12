import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDismissed, dismissKey, loadDismissed, removeDismissed } from '../src/team/dismissed.ts';

test('a dismissed whiteboard item is kept once, matched despite small rewording, and survives bad files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dismissed-'));
  const path = join(dir, 'dismissed.json');
  assert.deepEqual(loadDismissed(path), []);
  addDismissed(path, 'Pebble', 'Email the testers about v2', undefined, 1);
  addDismissed(path, 'Pebble', 'email the testers about v2.', undefined, 2); // same item again
  addDismissed(path, 'Atlas', 'Ship the BRAW fix', 'braw-fix', 3);
  const list = loadDismissed(path);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((d) => d.at), [2, 3]);
  assert.equal(list[1]!.job, 'braw-fix');
  assert.equal(dismissKey('Pebble', '**Email** the testers about v2!'), dismissKey('pebble', 'email the testers about v2'));
  assert.notEqual(dismissKey('Pebble', 'Email the testers'), dismissKey('Atlas', 'Email the testers'));
  // Control characters can't reach the manager's chat through the file.
  addDismissed(path, 'Room\nX', 'line\u001b[2Jtwo', undefined, 4);
  const last = loadDismissed(path).at(-1)!;
  assert.equal(last.room, 'Room X');
  assert.ok(!/[\x00-\x1f]/.test(last.text));
  // Bring back: removed by the same loose match, once.
  assert.equal(removeDismissed(path, 'atlas', 'Ship the BRAW fix.')?.job, 'braw-fix');
  assert.equal(removeDismissed(path, 'Atlas', 'Ship the BRAW fix'), undefined);
  assert.equal(loadDismissed(path).length, 2);
  // A job that was waiting on the owner keeps what for, so Bring back can restore it.
  addDismissed(path, 'Watch Face', 'Send the testers mail', 'dew-mail', 5, 'send the draft');
  addDismissed(path, 'Notes', 'Just a suggestion', undefined, 6, 'ignored without a job');
  assert.equal(removeDismissed(path, 'Watch Face', 'Send the testers mail')?.waitingFor, 'send the draft');
  assert.equal(loadDismissed(path).at(-1)!.waitingFor, undefined);
  writeFileSync(path, '{not json');
  assert.deepEqual(loadDismissed(path), []);
});
