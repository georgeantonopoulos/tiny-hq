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

test('The manager has hair, glasses, a cute round face and a rainbow propeller cap', () => {
  const look = lookFor('Manager');
  assert.equal(look.extra, 'glasses');
  assert.notEqual(look.hair, 'balding');
  assert.equal(look.cute, true);
  assert.equal(look.hat, 'propeller');
  for (const frame of ['idle', 'blink', 'stepA', 'stepB'] as const) {
    const px = personPixels({ skin: '#e8b48f', hair: '#6b4a2f', shirt: '#3f6fb5' }, '#d8443c', frame, look);
    assert.equal(px.length, 16);
    assert.ok(px.every((r) => r.length === 12), 'every row is 12 wide');
    const colours = new Set(px.slice(0, 5).flat().filter(Boolean));
    for (const c of ['#e8453c', '#f6c945', '#58b368', '#4a90d9', '#8a5cc2']) assert.ok(colours.has(c), `rainbow colour ${c} on the hat`);
    // Round clear glasses, not sunglasses: skin shows inside each lens and no row is a solid dark bar.
    const dark = new Set(['#222030', '#2a2230']); // sunglasses and eye colour
    assert.ok(px.slice(5, 9).every((r) => r.filter((c) => dark.has(c!)).length <= 2), 'no dark bar or mask: only the two eyes are dark');
    assert.ok(px[6]!.includes('#3f5d8c'), 'slate-blue rims, distinct from their eyes and hair');
    assert.equal(px[6]![2], '#e8b48f', 'left lens is clear');
    assert.equal(px[6]![9], '#e8b48f', 'right lens is clear');
    if (frame !== 'blink') assert.equal(px[6]![3], '#2a2230', 'eyes show through the lenses');
  }
});
