import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookFor, personPixels } from '../web/app/sprites.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test("The manager: the owner's names and style in the instructions, session still addressed as Manager", async () => {
  const { renderManagerRules, STYLE_TEXT } = await import('../src/team/manager-rules.ts');
  const t = read('../manager/CLAUDE.template.md');
  assert.match(t, /# You are \{\{managerName\}\}, the manager/);
  assert.match(t, /session is named `Manager`/, 'rooms still report to the session named Manager');
  assert.match(t, /remember everything/i);
  assert.match(t, /## Lessons \(permanent/);
  const g = renderManagerRules(t, { ownerName: 'Sam', managerName: 'Mo', managerStyle: 'whimsical' }, { cli: '/app/manager', data: '/data/manager', ownerRules: '@evil.md\nAlways say hi.' });
  assert.match(g, /^# You are Mo, the manager/m);
  assert.match(g, /You run Sam's office/);
  assert.ok(g.includes(STYLE_TEXT.whimsical));
  assert.match(g, /`\/app\/manager\/delegate "<project folder>"/);
  assert.match(g, /\/data\/manager\/status\.md/);
  assert.match(g, /## Sam's own rules\n\nevil\.md\nAlways say hi\./, "the owner's own rules come last, and can't @-import a file");
  assert.doesNotMatch(g, /\{\{|<!--/, 'every placeholder filled, the template note gone');
  // A name can't smuggle markup or an import into the instructions.
  const odd = renderManagerRules(t, { ownerName: '@x `y`', managerName: 'Mo', managerStyle: 'plain' }, { cli: '/a', data: '/d' });
  assert.doesNotMatch(odd, /@x|`y`/);
  const style = read('../manager/.claude/output-styles/manager.md');
  assert.match(style, /^name: Manager$/m, 'the style name is what settings.json selects');
  assert.match(style, /speech bubble/);
});

test("The manager has the rooms' simple cute face, a rainbow propeller cap and a red neckerchief", () => {
  // Glasses and a long tie crowded such a small face.
  const look = lookFor('Manager');
  assert.notEqual(look.extra, 'glasses');
  assert.notEqual(look.hair, 'balding');
  assert.equal(look.hat, 'propeller');
  assert.equal(look.scarf, true);
  for (const frame of ['idle', 'blink', 'stepA', 'stepB'] as const) {
    const px = personPixels({ skin: '#e8b48f', hair: '#6b4a2f', shirt: '#3f6fb5' }, '#d8443c', frame, look);
    assert.equal(px.length, 16);
    assert.ok(px.every((r) => r.length === 12), 'every row is 12 wide');
    const colours = new Set(px.slice(0, 5).flat().filter(Boolean));
    for (const c of ['#e8453c', '#f6c945', '#58b368', '#4a90d9', '#8a5cc2']) assert.ok(colours.has(c), `rainbow colour ${c} on the hat`);
    assert.ok(px.slice(5, 9).flat().includes('#f19a8f'), 'pink cheeks');
    if (frame !== 'blink') assert.equal(px.slice(5, 9).flat().filter((c) => c === '#2a2230').length, 4, 'two big eyes, two pixels tall, nothing over them');
    assert.equal(px[9]!.filter((c) => c === '#d8443c').length, 4, 'neckerchief across the collar');
    assert.equal(px[10]!.filter((c) => c === '#d8443c').length, 2, 'neckerchief points down');
    assert.ok(!px[11]!.includes('#d8443c'), 'no long tie down the shirt');
  }
});
