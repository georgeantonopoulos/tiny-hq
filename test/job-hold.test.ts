import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, describeJobs, isHeld, MAX_NUDGES_PER_DAY, parseUntil, QUIET_MS, validJob, type Job } from '../src/team/jobs.ts';
import { localDay } from '../src/team/schedule.ts';

const now = new Date(2026, 10, 7, 15, 0).getTime();
const job: Job = validJob({ id: 'pebble-beta', room: '/Users/g/Dev/Watch Face', title: 'Pebble in testing', done: 'the testers shows Day 1', status: 'active', createdAt: 1, updatedAt: 1 })!;
const quiet = { status: 'idle', state: 'done', lastActive: now - QUIET_MS - 1, viewed: false };

test('hold: waiting on an outside event means no nudges and no stuck report until the time, then it carries on', () => {
  const until = now + 12 * 3_600_000;
  const held: Job = { ...job, holdFor: "the testers' Day 1", holdUntil: until };
  assert.ok(isHeld(held, now));
  const stuck: Job = { ...held, nudgeDay: localDay(new Date(now)), nudgesToday: MAX_NUDGES_PER_DAY };
  assert.equal(decide(held, quiet, now), 'none');
  assert.equal(decide(held, undefined, now), 'none');
  assert.equal(decide(stuck, quiet, until - 1), 'none');
  // After the time it is an ordinary active job again.
  assert.ok(!isHeld(held, until));
  assert.equal(decide(held, quiet, until), 'nudge');
  assert.match(describeJobs([held], (p) => p, now), /HOLDING until[^\n]*waiting for the testers' Day 1/);
  // Only an active job can be held.
  assert.equal(validJob({ ...held, status: 'waiting', waitingFor: 'x' })!.holdUntil, undefined);
  assert.equal(validJob(held)!.holdUntil, until);
});

test('hold times: clock time, full date, "in 3h"; the past and the far future are refused', () => {
  assert.equal(parseUntil('03:00', now), new Date(2026, 10, 8, 3, 0).getTime());
  assert.equal(parseUntil('2026-11-08 03:00', now), new Date(2026, 10, 8, 3, 0).getTime());
  assert.equal(parseUntil('in 3h', now), now + 3 * 3_600_000);
  assert.equal(parseUntil('2026-11-06 03:00', now), undefined);
  assert.equal(parseUntil('in 30d', now), undefined);
  assert.equal(parseUntil('tomorrow-ish', now), undefined);
});

test('job hold from the command line: held, no owner ask, and go ends the hold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-hold-'));
  mkdirSync(join(dir, 'manager'));
  const env = { ...process.env, CM_DATA_DIR: dir };
  const cli = (...a: string[]) => execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', new URL('../src/cli/job.ts', import.meta.url).pathname, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const file = join(dir, 'manager', 'jobs.json');
  writeFileSync(file, JSON.stringify({ jobs: [{ ...job, room: dir }] }));
  assert.match(cli('hold', 'pebble-beta', 'the testers Day 1', '--until', 'in 2h'), /held until/);
  const saved = JSON.parse(readFileSync(file, 'utf8')).jobs[0];
  assert.equal(saved.status, 'active');
  assert.equal(saved.holdFor, 'the testers Day 1');
  assert.ok(saved.holdUntil > Date.now());
  assert.throws(() => cli('hold', 'pebble-beta', 'x', '--until', 'whenever'));
  assert.throws(() => cli('hold', 'pebble-beta', 'no time given'));
  cli('go', 'pebble-beta');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].holdUntil, undefined);
});
