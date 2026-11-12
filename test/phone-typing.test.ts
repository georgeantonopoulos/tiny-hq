import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedDiff } from '../web/app/phone-typing.ts';

const B = '\x7f';

test('phone typing sends only what changed in the keyboard box', () => {
  assert.equal(typedDiff('', 'hello'), 'hello'); // a swiped word
  assert.equal(typedDiff('hello', 'hello '), ' '); // space after it
  assert.equal(typedDiff('hello', 'hello'), ''); // the same box twice sends nothing (no duplicates)
  assert.equal(typedDiff('teh', 'the'), B + B + 'he'); // autocorrect
  assert.equal(typedDiff('hello world', 'hello'), B.repeat(6)); // swipe-delete a word
  assert.equal(typedDiff('fix the bug', 'fix that bug'), B.repeat(5) + 'at bug'); // a suggestion swapped mid-sentence
  assert.equal(typedDiff('ok', 'ok\n'), '\r'); // Enter that arrived as a new line
  assert.equal(typedDiff('hi 😀', 'hi 😃'), B + '😃'); // an emoji is one backspace, never half of one
  assert.equal(typedDiff('ok 👍🏽', 'ok '), B); // skin tone: still one character
  assert.equal(typedDiff('go 🇬🇷', 'go 🇬🇷!'), '!'); // a flag stays whole
  assert.equal(typedDiff('go 🇬🇷', 'go 🇪🇸'), B + '🇪🇸'); // flags share a first half: never split
});
