import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs hook, no types
import { askedWithButton, lastReply, questionsOwner, thisTurn } from '../hooks/manager-ask-guard.mjs';
import { fill, HAPPENINGS, MANAGER_HAPPENINGS, nextHappening } from '../web/app/whimsy.ts';

const HOOK = new URL('../hooks/manager-ask-guard.mjs', import.meta.url).pathname;
const user = (text: string) => ({ type: 'user', timestamp: '2026-11-10T08:00:00Z', message: { content: text } });
const said = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const ran = (command: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const result = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });

function runHook(rows: object[], active = false, o: { hook?: string; dir?: string } = {}): string {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'cm-askguard-'));
  const t = join(dir, 't.jsonl');
  writeFileSync(t, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return execFileSync(process.execPath, [o.hook ?? HOOK], { input: JSON.stringify({ transcript_path: t, stop_hook_active: active }), encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: dir } });
}

test('a question to the owner in chat sends the manager back to make it a button', () => {
  // The slip this check exists for.
  const out = runHook([user('The owner: more whimsy please'), said('On it. Shall I ask Rosa to add whimsical happenings to the floor?')]);
  assert.match(JSON.parse(out).reason, /manager\/ask/);
  // Asked with a button this turn: fine.
  assert.equal(runHook([user('The owner: more whimsy please'), ran('~/.tiny-hq/app/manager/ask "Add whimsy?" --why choice --tried "x"'), result(), said('Question is over my head, the owner. Want me to wait?')]), '');
  // job wait also puts up a button.
  assert.equal(runHook([user('x'), ran('/Users/g/Dev/tiny-hq/manager/job wait j1 "do it" --why send --tried "y"'), result(), said('Do you want it?')]), '');
  // Only the turn that just ended counts: an ask in an earlier turn doesn't excuse this one.
  assert.match(runHook([user('a'), ran('~/.tiny-hq/app/manager/ask "q" --why choice --tried "x"'), result(), said('Up.'), user('b'), said('Should I start Rex on it?')]), /block/);
  // Once per turn: sent back, they answer again with the same question: let it through (never loops).
  const dir = mkdtempSync(join(tmpdir(), 'cm-askguard-'));
  const turn = [user('a'), said('Shall I start Rex?')];
  assert.match(runHook(turn, false, { dir }), /block/);
  const feedback = { type: 'user', isMeta: true, timestamp: '2026-11-10T08:01:00Z', message: { content: 'Stop hook feedback:\nQuestion check' } };
  assert.equal(runHook([...turn, feedback, said('Shall I start Rex, the owner?')], true, { dir }), '');
  // The whiteboard check sent them back first (stop_hook_active): the reply after that is still checked.
  const wb = { type: 'user', isMeta: true, timestamp: '2026-11-10T08:00:30Z', message: { content: 'Stop hook feedback:\nWhiteboard check' } };
  assert.match(runHook([user('b'), said('Done.'), wb, said('Notebook updated. Want me to start Rex?')], true), /block/);
  // they asked, the whiteboard sent them back, they said (quiet); the bubble still shows the question.
  assert.match(runHook([user('Keep the bubbles short please'), said('Understood. Shall I ask her?'), wb, said('(quiet)')], true), /block/);
  // An office ping mid-turn doesn't hide the button they already put up.
  assert.equal(runHook([user('c'), ran('~/.tiny-hq/app/manager/ask "Start Rex?" --why choice --tried "x"'), result(), user('[Office: job "x" is not done yet] ...'), said('Want me to wait for it?')]), '');
});

test('the check runs from a folder reached by a symlink, with a space in its path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-askguard-'));
  mkdirSync(join(dir, 'real dir'));
  copyFileSync(HOOK, join(dir, 'real dir', 'manager-ask-guard.mjs'));
  symlinkSync(join(dir, 'real dir'), join(dir, 'linked dir'));
  assert.match(runHook([user('a'), said('Want me to start Rex?')], false, { hook: join(dir, 'linked dir', 'manager-ask-guard.mjs') }), /block/);
});

test('rhetorical asides and statements are not questions to them', () => {
  for (const ok of ['Lumen is green; the universe and I are both pleased.', '*Who knew a build could find itself?* Rex is on it.', 'Rex asked the build `why?` and it answered.', 'Who left the plant in charge? The plant, apparently.'])
    assert.equal(questionsOwner(ok), false, ok);
  for (const q of ['Want me to start Rex?', 'OK to post it?', 'Atlas is ready. Do you approve the text?', 'The owner, coffee first?', 'Text is drafted. Sound good?', '**Want me to start Rex?**', '*Shall I ask Rosa, the owner?*'])
    assert.equal(questionsOwner(q), true, q);
});

test('the turn, the reply and the button are read from the transcript', () => {
  const lines = [user('a'), said('old'), user('b'), ran('manager/ask "x"'), result(), said('first'), said('final words')].map((r) => JSON.stringify(r));
  const turn = thisTurn(lines);
  assert.equal(lastReply(turn), 'final words');
  assert.equal(askedWithButton(turn), true);
});

test('floor happenings: told by a narrator, never over someone busy, the owner never called boss', () => {
  const cast = [
    { id: 'manager', first: 'Mo', room: 'Manager' },
    { id: 'lead:lumen', first: 'Rex', room: 'Lumen' },
  ];
  assert.equal(nextHappening(cast, () => false), undefined, 'nobody free: nothing happens');
  const h = nextHappening(cast, (id) => id === 'lead:lumen', () => 0)!;
  assert.equal(h.id, 'lead:lumen');
  assert.ok(!h.text.includes('{'), 'names filled in');
  assert.ok(MANAGER_HAPPENINGS.map((l) => l.replaceAll('The Manager', 'Mo')).includes(nextHappening(cast, (id) => id === 'manager', () => 0)!.text), 'manager lines by the name the owner gave them');
  assert.equal(fill('{name} in {room}', { id: 'x', first: '', room: '' }), 'Someone in The office');
  for (const l of [...HAPPENINGS, ...MANAGER_HAPPENINGS]) assert.ok(!/\bboss\b/i.test(l), l);
});

test("The manager's voice: never 'boss'; Lesson 8 kept", () => {
  const rules = readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8');
  const style = readFileSync(new URL('../manager/.claude/output-styles/manager.md', import.meta.url), 'utf8');
  for (const text of [rules, style]) {
    assert.match(text, /the owner/);
    // "boss" only where it's quoted from the owner or on the mug.
    const left = text.replace(/never "boss"/gi, '');
    assert.doesNotMatch(left, /\bboss\b/i);
  }
  assert.match(rules, /8\. \*\*A question is a button\.\*\*/);
  const settings = JSON.parse(readFileSync(new URL('../manager/.claude/settings.json', import.meta.url), 'utf8'));
  assert.ok(JSON.stringify(settings.hooks.Stop).includes('manager-ask-guard.mjs'), 'the check runs after every manager turn');
});
