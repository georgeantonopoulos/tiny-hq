import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Each chat tab gets a colour in line with the office, so the owner can tell them apart.
test('chat tabs wear their person colour from the floor', () => {
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.term-tab \{ --who: [^;]+; border-top: 3px solid var\(--who\); \}/);
  const main = readFileSync(new URL('../web/app/main.ts', import.meta.url), 'utf8');
  assert.match(main, /terminal\.colourFor = /);
  assert.match(main, /lead\?\.palette\.shirt/);
  assert.match(main, /office\.render\(floor, handlers\);\n\s+terminal\.renderTabs\(\);/, 're-coloured once the floor is drawn');
});

test('no two open tabs wear the same colour', async () => {
  const { tabColours } = await import('../web/app/tab-colours.ts');
  // Pip and Rex both have red shirts on the floor, Rosa and Cora both teal.
  const c = tabColours(['#c0504d', '#3a9bb5', '#3A9BB5', '#c0504d', '#8a5cc0', undefined]);
  assert.equal(c[0], '#c0504d', 'the first keeps its own shirt');
  assert.equal(c[1], '#3a9bb5');
  assert.equal(new Set(c).size, c.length, 'all different');
  assert.equal(c[4], '#8a5cc0', 'a unique shirt stays as it is');
});
