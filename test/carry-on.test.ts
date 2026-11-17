import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stoppedOnError } from '../src/terminal/sessions.ts';

const ID = '11111111-2222-3333-4444-555555555555';
const CWD = '/Users/x/Dev/example-app';
function home(recs: object[]): string {
  const h = mkdtempSync(join(tmpdir(), 'cm-carry-'));
  const dir = join(h, '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return h;
}
const at = '2026-11-17T09:00:00.000Z';
const user = { type: 'user', timestamp: at, message: { role: 'user', content: 'build it' } };
const said = { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] } };
const apiError = (text: string) => ({
  type: 'assistant',
  timestamp: at,
  isApiErrorMessage: true,
  error: 'server_error',
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
});

test('a turn cut off by a dropped connection is spotted', () => {
  const h = home([user, said, apiError('API Error: Connection lost mid-response. The response above may be incomplete.')]);
  const got = stoppedOnError(ID, CWD, h);
  assert.equal(got?.text, 'API Error: Connection lost mid-response. The response above may be incomplete.');
  assert.equal(got?.at, Date.parse(at));
});

test('errors only a person can fix are left alone', () => {
  for (const text of ['Please run /login · API Error: 403', 'Login expired · Please run /login', "You've hit your session limit · resets 2:20am (Europe/London)", "You've hit your 5-hour limit · resets 9:10pm", 'Credit balance is too low', 'Claude usage limit reached', 'Prompt is too long', '']) {
    assert.equal(stoppedOnError(ID, CWD, home([user, apiError(text)])), undefined, text);
  }
});

test('an error someone already answered, or a normal ending, is not a stall', () => {
  assert.equal(stoppedOnError(ID, CWD, home([user, apiError('API Error: Connection lost mid-response.'), user])), undefined);
  assert.equal(stoppedOnError(ID, CWD, home([user, said])), undefined);
  assert.equal(stoppedOnError(ID, CWD, home([user, apiError('API Error: 529 overloaded'), said])), undefined);
});

test('a subagent error does not count as the main turn stopping', () => {
  const side = { ...apiError('API Error: Connection lost'), isSidechain: true };
  assert.equal(stoppedOnError(ID, CWD, home([user, said, side])), undefined);
});

test('the office types "carry on" only through typeInto, under the leave-alone rule', () => {
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('async function carryOnAfterApiErrors'), main.indexOf('// Long conversations'));
  assert.match(fn, /await typeInto\(s, `Your last reply was cut off/);
  assert.match(fn, /leaveAlone\(s, asking, now\)/);
  assert.match(fn, /isOnCall\(s\.realCwd, config\.onCallProjects\)/);
  assert.match(main, /await carryOnAfterApiErrors\(\);/);
});
