// A promise in a room's report becomes part of its job, and the job can't be marked done until it's
// delivered: a promise made in passing ("pictures coming") is otherwise easily forgotten and the job
// closes without it. The Stop hook no longer reads replies for promises: adding one is the room's part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJobs, nudgeLine, describeJobs, openOwed, trimOwed, validJob, MAX_OWED } from '../src/team/jobs.ts';
import { HOOKS } from '../src/cli/install.ts';

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
