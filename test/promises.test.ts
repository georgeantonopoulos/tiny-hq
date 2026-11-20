// A promise in a room's report becomes part of its job, and the job can't be marked done until it's
// delivered: a promise made in passing ("pictures coming") is otherwise easily forgotten and the job
// closes without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJobs, nudgeLine, describeJobs, openOwed, trimOwed, validJob, MAX_OWED } from '../src/team/jobs.ts';
import { HOOKS } from '../src/cli/install.ts';
// @ts-expect-error plain .mjs hook
import { promises, tagFile } from '../hooks/room-ask-guard.mjs';

test('promises are read from a report; plain statements and questions are not promises', () => {
  for (const t of ['Pictures coming next.', "I'll send the screenshots once the render ends.", 'The node pictures are on their way.', "I'll report back with numbers.", 'Results to follow tomorrow.'])
    assert.equal(promises(t).length, 1, t);
  for (const t of ['Done: tests pass, merged #12.', 'You will see it in the office.', 'Coming up next is the deploy step.', 'The office will send a nudge.', "Run `I'll send pictures` in the shell."])
    assert.equal(promises(t).length, 0, t);
});

test("an owed item survives the file, shows on the nudge and on the manager's list, and the nudge still ends on \"done\"", () => {
  const j = validJob({ id: 'nodes', room: '/x/garden', title: 'Node pictures', done: 'pictures sent', status: 'active', owed: [{ what: 'node pictures for the owner', at: 1 }, { what: 'old', at: 1, delivered: 2, how: '/tmp/a.png' }] })!;
  assert.equal(j.owed?.length, 2);
  assert.deepEqual(openOwed(j).map((o) => o.what), ['node pictures for the owner']);
  const line = nudgeLine({ ...j, done: 'x'.repeat(1200), owed: Array.from({ length: 20 }, (_, i) => ({ what: `thing ${i} ${'y'.repeat(290)}`, at: 1 })) }, '/c/manager/job');
  assert.match(line, /You promised and haven't delivered yet: \(1\) thing 0/);
  assert.match(line, /and 15 more/);
  assert.match(line, /run: \/c\/manager\/job done nodes and report to the manager\.$/);
  assert.match(describeJobs([j], (p) => p), /still owed: node pictures for the owner/);
});

const CLI = new URL('../src/cli/job.ts', import.meta.url).pathname;
test('job done is refused while a promise is open; owe and delivered move it along', () => {
  const data = mkdtempSync(join(tmpdir(), 'owe-'));
  const room = mkdtempSync(join(tmpdir(), 'room-'));
  const cli = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...a], { env: { ...process.env, CM_DATA_DIR: data }, encoding: 'utf8' });
  assert.equal(cli('add', 'nodes', room, 'Node pictures', '--done', 'pictures sent').status, 0);
  assert.equal(cli('owe', 'nodes', 'node pictures for the owner').status, 0);
  const refused = cli('done', 'nodes');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /still owes[\s\S]*1\. node pictures for the owner/);
  assert.equal(loadJobs(join(data, 'manager', 'jobs.json'))[0]!.status, 'active');
  assert.notEqual(cli('delivered', 'nodes', '1').status, 0); // where it is, or it doesn't count
  assert.equal(cli('delivered', 'nodes', '1', 'sent to the manager: /tmp/nodes.png').status, 0);
  // The manager re-adding the job keeps what was promised.
  assert.equal(cli('add', 'nodes', room, 'Node pictures', '--done', 'pictures sent').status, 0);
  assert.equal(loadJobs(join(data, 'manager', 'jobs.json'))[0]!.owed?.[0]?.how, 'sent to the manager: /tmp/nodes.png');
  assert.equal(cli('done', 'nodes').status, 0);
  assert.equal(loadJobs(join(data, 'manager', 'jobs.json'))[0]!.status, 'done');
});

const HOOK = new URL('../hooks/room-ask-guard.mjs', import.meta.url).pathname;
const line = (o: object) => JSON.stringify(o);
test('the Stop check sends a room back once when its report promises something and the job does not owe it', () => {
  const data = mkdtempSync(join(tmpdir(), 'owe-'));
  const room = mkdtempSync(join(tmpdir(), 'room-'));
  mkdirSync(join(data, 'tags'));
  mkdirSync(join(data, 'manager'));
  writeFileSync(tagFile(room, data), 'tag');
  writeFileSync(join(data, 'manager', 'jobs.json'), JSON.stringify({ jobs: [{ id: 'nodes', room, title: 't', done: 'd', status: 'active', createdAt: 1, updatedAt: 1 }] }));
  const t = join(data, 't.jsonl');
  const report = line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'manager', message: 'Keyer fixed. Node pictures coming shortly.' } }] } });
  const reply = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Keyer fixed.' }] } });
  const run = () => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ transcript_path: t, cwd: room }), env: { ...process.env, CM_DATA_DIR: data, CLAUDE_PROJECT_DIR: room }, encoding: 'utf8' }).stdout;
  writeFileSync(t, [line({ type: 'user', message: { content: 'go' } }), report, reply].join('\n'));
  const out = run();
  assert.match(out, /"decision":"block"/);
  assert.match(out, /job owe nodes/);
  assert.equal(run(), ''); // once per turn
  // Owed this turn: nothing to say.
  writeFileSync(t, [line({ type: 'user', message: { content: 'again' } }), report, line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: '~/.tiny-hq/app/manager/job owe nodes "node pictures"' } }] } }), reply].join('\n'));
  assert.equal(run(), '');
  // No open job: a promise is just a sentence.
  writeFileSync(join(data, 'manager', 'jobs.json'), JSON.stringify({ jobs: [] }));
  writeFileSync(t, [line({ type: 'user', message: { content: 'third' } }), report, reply].join('\n'));
  assert.equal(run(), '');
});

test('the check is wired: room-ask-guard.mjs is a Stop hook the setup installs', () => {
  const spec = HOOKS.find((h) => h.file === 'room-ask-guard.mjs');
  assert.ok(spec, 'room-ask-guard.mjs is in the setup hooks');
  assert.equal(spec!.event, 'Stop');
});

test('delivered promises make room for new ones, and an open one is never dropped or renumbered by the file', () => {
  const full = Array.from({ length: MAX_OWED }, (_, i) => ({ what: `t${i}`, at: 1, ...(i % 2 ? {} : { delivered: 2 }) }));
  const next = trimOwed([...full, { what: 'new', at: 3 }]);
  assert.equal(next.length, MAX_OWED);
  assert.deepEqual(openOwed({ owed: next }).map((o) => o.what), [...full.filter((o) => !o.delivered).map((o) => o.what), 'new']);
  assert.equal(next[0]!.what, 't1'); // the oldest delivered one went
  const j = validJob({ id: 'a', room: '/x', title: 't', done: 'd', status: 'active', owed: full })!;
  assert.deepEqual(j.owed!.map((o) => o.what), full.map((o) => o.what));
});
