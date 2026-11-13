// A step only the owner's hands can do (a switch in macOS System Settings) used to get Approve / No,
// which reads as "the office will do it", so nothing happened. It now reads "Done, I did it" / "Stuck",
// and the room is told to check it really took.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAsk, answerLine, isHands, roomLine } from '../src/team/asks.ts';

test("a step only the owner's hands can do reads Done / Stuck, and the room checks it took", () => {
  const [a] = addAsk([], '/Users/owner/Dev/app', 'Switch on the screen helper in Screen Recording', 1, 'abcdef12', undefined, 'see-screen', undefined, false, undefined, { why: 'hands', tried: 'helper runs, screenshot refused' });
  assert.equal(isHands(a!), true);
  const yes = answerLine(a!, true)!;
  assert.match(yes, /they say they did it themselves/);
  assert.match(yes, /Done, I did it/);
  assert.match(yes, /really took/);
  assert.match(answerLine(a!, false)!, /stuck/);
});

test('a hands button the manager put over a room: the room line says the same', () => {
  const [g] = addAsk([], '/Users/owner/Dev/app', 'Tick it', 1, 'abcdef13', '4e57e00a-b543-4431-993f-166f41737e7f', undefined, undefined, true, undefined, { why: 'hands', tried: 'helper runs, screenshot refused' });
  assert.match(roomLine(g!, { yes: true })!, /really took/);
});

test('a permission button stays Approve: it is for one exact command their settings refuse', () => {
  const [p] = addAsk([], '/x', 'Run rm -rf build', 1, 'abcdef14', undefined, undefined, undefined, false, undefined, { why: 'permission', tried: 'their settings refuse it' });
  assert.equal(isHands(p!), false);
});
