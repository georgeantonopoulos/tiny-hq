import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addAsk, answerLine, roomLine, wantsAction } from '../src/team/asks.ts';

const MANAGER = '11111111-2222-3333-4444-555555555555';
const over = (options?: string[]) => addAsk([], '/Users/g/Dev/Website', "Website: merge Rosa's fix to main?", 1, 'abc12345', MANAGER, undefined, options, true)[0]!;

test("a pick on a question the manager put over a room reaches the room as the owner's own click", () => {
  // A relayed answer would rightly be refused by the room, and the owner would have to click twice.
  const ask = over(['Merge it', 'Not yet']);
  const line = roomLine(ask, { choice: 0 })!;
  assert.match(line, /^The owner chose: "Merge it"\./);
  assert.match(line, /They picked it themselves on the button over your head/);
  assert.match(line, /not a relay: act on it now/);
  assert.match(line, /Website: merge Rosa's fix to main\?/);
  assert.match(line, /the other options were "Not yet"/);
  // Yes and no work the same way.
  assert.match(roomLine(over(), { yes: true })!, /^The owner: yes, go ahead: .*clicked Approve themselves/);
  assert.match(roomLine(over(), { yes: false })!, /^The owner: no: .*Don't do it/);
  // The manager's copy is the usual line (the office adds that the room already has it).
  assert.match(answerLine(ask, { choice: 0 })!, /^The owner chose: "Merge it"/);
});

test("a room's own question, a job's button or a trust button never get the room copy", () => {
  const own = addAsk([], '/Users/g/Dev/Website', 'Merge?', 1, 'own12345', MANAGER)[0]!;
  assert.equal(roomLine(own, { yes: true }), undefined);
  const trust = addAsk([], '/Users/g/Dev/Orbit', 'Trust?', 1, 'tru12345', MANAGER, undefined, undefined, true, { name: 'Orbit', task: 'x' })[0]!;
  assert.equal(roomLine(trust, { yes: true }), undefined);
  assert.equal(roomLine(over(['A', 'B']), { yes: true }), undefined, 'a yes/no answer to a multiple choice is refused');
  // A long question or long options never cut off the instruction at the end.
  const long = addAsk([], '/Users/g/Dev/Website', 'Q '.repeat(300), 1, 'lon12345', MANAGER, undefined, ['A'.repeat(100), 'B'.repeat(100), 'C'.repeat(100), 'D'.repeat(100), 'E'.repeat(100), 'F'.repeat(100)], true)[0]!;
  assert.match(roomLine(long, { choice: 0 })!, /act on it now\.\)$/);
  assert.match(roomLine({ ...long, options: undefined }, { yes: false })!, /Don't do it; carry on with anything else you have\.$/);
});

test('only a real go-ahead starts a session in an empty room', () => {
  const next = over(['Polish colourspace', 'Fix the Linux zip', 'Nothing now']);
  assert.equal(wantsAction(next, { choice: 0 }), true);
  assert.equal(wantsAction(next, { choice: 2 }), false);
  for (const o of ['No', 'Not yet', 'Not now', 'Skip', 'Later', 'Leave it']) assert.equal(wantsAction(over(['Go', o]), { choice: 1 }), false, o);
  // Real options that only start with those words are not a no.
  for (const o of ['Skip CI and merge', 'Leave a PR comment draft', 'Later release, merge now', 'No-risk option']) assert.equal(wantsAction(over([o, 'Nothing now']), { choice: 0 }), true, o);
  assert.equal(wantsAction(over(), { yes: true }), true);
  assert.equal(wantsAction(over(), { yes: false }), false);
});

test('the office delivers it: the room first, then the manager with a note not to relay', () => {
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  const at = main.indexOf('const toRoom = roomLine(ask, answer);');
  assert.ok(at > 0, 'deliverAnswer types the room line');
  const block = main.slice(at, at + 6000);
  assert.ok(block.indexOf('typeInto(roomSession') < block.indexOf('tellManager(copy)'), 'room first, the manager second');
  assert.match(block, /try \{\s*const told/, "The manager's copy can't throw and put the question back");
  assert.match(block, /isTrusted\(who\.path\)/, 'an untrusted folder never claims a start');
  assert.match(block, /don\\?'t relay it/);
});
