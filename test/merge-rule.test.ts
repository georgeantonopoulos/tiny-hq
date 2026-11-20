import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkOnlyOwner, MERGE_RULE } from '../src/team/only-owner.ts';
import { stepLine } from '../src/team/autonomy.ts';

// A room merges its own PR once tests and an independent review pass; releases and public deploys stay
// the owner's (a "ready for you to merge" on a clean PR is a click they gain nothing from).
const T = 'tests pass, Codex review answered';
test('a Merge button is refused; a release, a public deploy or a refused command still reaches the owner', () => {
  for (const [why, text] of [
    ['choice', 'Merge #49? | Merge | Wait'],
    ['irreversible', 'Ready to merge PR #12 into main?'],
    ['choice', 'PR #46 is clean. | Merge | Wait | Changes first'],
    ['choice', 'Merge the fix branch to master?'],
    ['irreversible', 'The PR is green: merge it? | Yes | No'],
    ['irreversible', 'Merge notes PR 21 (all five branches plus fixes) into main?'],
    ['choice', 'PR 21 is ready. Merge it? | Yes | No'],
  ])
    assert.match(checkOnlyOwner(why, T, text) ?? '', /No Merge button/, text);
  for (const [why, text] of [
    ['post', 'Merge #50 and deploy the garden site publicly'],
    ['choice', 'Merge #51 and release 0.3.1, or wait? | Release now | Wait'],
    ['permission', 'Their settings refuse `gh pr merge 49 --squash`: approve that one command?'],
    ['choice', 'Should the Merge node default to Over or Plus? | Over | Plus'],
    ['choice', 'Which node joins the two plates? | Merge | Plus'],
    ['choice', 'Resolve the merge conflict on branch fix-1 by keeping both? | Keep both | Mine'],
    ['choice', 'Which data source for the report? | Sheet | API'],
    // Background that mentions a merge, asking something else
    ['choice', 'Two rooms ended on a question (Garden: PR #16 merge waits on you). Fix the end-of-turn check? | Fix both | Leave it'],
    ['choice', 'The only thing left on #16 is the merge, which puts the new title live on the site. | Merge now | Wait'],
  ])
    assert.equal(checkOnlyOwner(why, T, text), undefined, text);
});

// Unwired is the failure: every text that tells a room about merging carries the one rule, and none
// still says merges wait for the owner.
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ');
test('every text rooms read about merging carries the rule, and none says merges wait for the owner', () => {
  const rule = squash(MERGE_RULE).replace(/^Merging is yours: /, '');
  const texts: Record<string, string> = {
    'skills/theoffice/SKILL.md': read('skills/theoffice/SKILL.md'),
    'manager/CLAUDE.template.md': read('manager/CLAUDE.template.md').replace(/\{\{ownerName\}\}/g, 'the owner'),
    'goal step line': stepLine('Polish the app', 'week 62% used', '/x/manager/ask'),
  };
  for (const [name, text] of Object.entries(texts)) assert.ok(squash(text).includes(rule.slice(30, 200)), `${name} carries MERGE_RULE`);
  const STALE = [/merg\w*[^.\n]{0,80}\b(needs?|without) (their|the owner's) yes/i, /merging[^.\n]{0,40}only when the owner asks/i, /leaves? merges? to (the owner|you|them)/i, /the owner (approves and )?merges/i, /ready for (the owner|you|them) to merge(?!", tell)/i];
  for (const name of ['skills/theoffice/SKILL.md', 'manager/CLAUDE.template.md', 'agents/worker-brief.md', 'src/team/autonomy.ts']) {
    const text = name in texts ? texts[name]! : read(name);
    for (const re of STALE) assert.doesNotMatch(text, re, `${name}: ${re}`);
  }
  for (const re of STALE) assert.doesNotMatch(texts['goal step line']!, re);
});
