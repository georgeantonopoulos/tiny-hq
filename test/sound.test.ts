import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowed, CUES, MIN_GAP_MS, NEWS_GAP_MS, VOLUME, type Cue } from '../web/app/sound.ts';

test('office sounds stay short and quiet', () => {
  for (const [cue, notes] of Object.entries(CUES)) {
    const end = Math.max(...notes.map((n) => n.at + n.len));
    assert.ok(end <= 0.5, `${cue} lasts ${end}s`);
    assert.ok(notes.length <= 4, `${cue} has ${notes.length} notes`);
    for (const n of notes) assert.ok(n.f >= 200 && n.f <= 2000, `${cue}: ${n.f} Hz is gentle`);
  }
  assert.ok(VOLUME <= 0.15, 'well under a system alert');
  // Questions and news sound different.
  assert.notDeepEqual(CUES.question, CUES.message);
});

test('never too much: one sound per 10 s, news at most once a minute, mic clicks always', () => {
  const t = 1_000_000;
  const fresh = { any: 0, news: 0 };
  for (const c of Object.keys(CUES) as Cue[]) assert.equal(allowed(c, t, fresh), true, c);
  assert.equal(allowed('question', t + MIN_GAP_MS - 1, { any: t, news: 0 }), false);
  assert.equal(allowed('question', t + MIN_GAP_MS, { any: t, news: 0 }), true);
  assert.equal(allowed('message', t + MIN_GAP_MS, { any: t, news: t }), false, 'news again within a minute');
  assert.equal(allowed('message', t + NEWS_GAP_MS, { any: t, news: t }), true);
  assert.equal(allowed('done', t + MIN_GAP_MS, { any: t, news: t }), true, 'a finished job is not held back by news');
  assert.equal(allowed('micOn', t + 1, { any: t, news: t }), true, "The owner's own press always clicks");
});

test('wired in: a mute switch next to the mic, no sound for working dots or the first look', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="sound"') > 0 && html.indexOf('id="sound"') < html.indexOf('id="mic"'), 'speaker switch sits just before the mic');
  const main = readFileSync(new URL('../web/app/main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(firstPoll \|\| quietCatchUp\) \{[^}]*sound\.arm\(\)/, "the first look, and the first after a hidden spell, stay silent");
  assert.doesNotMatch(main, /play\('work/, 'nothing plays for working dots');
});
