import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAsk, answerLine, isPassword, jobAnswered, roomLine, typedSince, wantsAction } from '../src/team/asks.ts';

// a room took Approve on "Sign in to App Store Connect" as leave to type the owner's password.
const pw = addAsk([], '/g/Dev/Pip', 'Sign in to App Store Connect', 1, 'aaaaaaaa', undefined, 'asc', undefined, false, undefined, { why: 'password', tried: 'Chrome had no session' })[0]!;
const plain = addAsk([], '/g/Dev/Pip', 'Ship it?', 1, 'bbbbbbbb', undefined, 'asc', undefined, false, undefined, { why: 'send', tried: 'x' })[0]!;

test('a password button: Done means they did it, never "go ahead"', () => {
  assert.ok(isPassword(pw));
  const done = answerLine(pw, { yes: true })!;
  assert.match(done, /^The owner: done, they did it themselves/);
  assert.match(done, /Don't type, fill or look up any password/);
  assert.doesNotMatch(done, /go ahead/);
  assert.equal(jobAnswered(pw, { yes: true }), 'asc');
});

test('"You sign in" allows only a saved passkey or password manager, and stops at anything else', () => {
  const t = answerLine(pw, { signIn: true })!;
  assert.match(t, /^The owner: sign in yourself/);
  assert.match(t, /passkey or password-manager autofill/);
  assert.match(t, /Never read, copy, note or type the password/);
  assert.match(t, /stop, leave it, and tell the manager/);
  assert.equal(jobAnswered(pw, { signIn: true }), 'asc');
  assert.ok(wantsAction(pw, { signIn: true }));
});

test('"You sign in" is refused on any other kind of question', () => {
  assert.equal(isPassword(plain), false);
  assert.equal(answerLine(plain, { signIn: true }), undefined);
  assert.equal(roomLine({ ...plain, askedFor: true }, { signIn: true }), undefined);
  assert.match(answerLine(plain, { yes: true })!, /go ahead/);
});

test('a password question the manager put over a room is worded the same in the room', () => {
  const t = roomLine({ ...pw, askedFor: true, job: undefined }, { yes: true })!;
  assert.match(t, /^The owner: done, they did it themselves/);
});

test("the office's own password lines never count as the owner typing", () => {
  const line = (text: string) => JSON.stringify({ type: 'user', timestamp: new Date(10).toISOString(), message: { content: text } });
  for (const a of [{ yes: true }, { yes: false }, { signIn: true }] as const) assert.equal(typedSince([line(answerLine(pw, a)!)], 0), undefined);
});
