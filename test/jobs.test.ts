import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_MS, checkLine, decide, GAP_MS, MAX_NUDGES_PER_DAY, nudged, nudgeLine, QUIET_MS, validJob, type Job } from '../src/team/jobs.ts';
import { localDay } from '../src/team/schedule.ts';

const now = new Date(2026, 10, 7, 15, 0).getTime();
const job: Job = validJob({ id: 'pebble-beta', room: '/Users/g/Dev/Watch Face', title: 'Pebble in testing', done: 'the testers shows Day 1', status: 'active', createdAt: 1, updatedAt: 1 })!;
const quiet = { status: 'idle', state: 'done', lastActive: now - QUIET_MS - 1, viewed: false };

test('a quiet room on an open job gets nudged', () => {
  assert.equal(decide(job, quiet, now), 'nudge');
});

test('never nudges a room that is working, blocked on a prompt, being watched, or only just went quiet', () => {
  assert.equal(decide(job, { ...quiet, status: 'busy' }, now), 'none');
  assert.equal(decide(job, { ...quiet, state: 'blocked' }, now), 'none');
  assert.equal(decide(job, { ...quiet, viewed: true }, now), 'none');
  assert.equal(decide(job, { ...quiet, lastActive: now - 60_000 }, now), 'none');
});

test('done: no nudges', () => {
  assert.equal(decide({ ...job, status: 'done' }, quiet, now), 'none');
});

test('waiting on the owner: checked every 15 minutes whether they have done it, never while the room is busy', () => {
  const waiting: Job = { ...job, status: 'waiting', waitingFor: 'send the email', updatedAt: now };
  assert.equal(decide(waiting, quiet, now + CHECK_MS - 1), 'none');
  assert.equal(decide(waiting, quiet, now + CHECK_MS), 'check');
  assert.equal(decide(waiting, undefined, now + CHECK_MS), 'check');
  assert.equal(decide(waiting, { ...quiet, status: 'busy' }, now + CHECK_MS), 'none');
  const checked = nudged(waiting, 'check', now + CHECK_MS);
  assert.equal(decide(checked, quiet, now + CHECK_MS + 60_000), 'none');
  assert.equal(decide(checked, quiet, now + 2 * CHECK_MS), 'check');
  assert.match(checkLine(waiting, 'job'), /sent mail/);
  assert.match(checkLine(waiting, 'job'), /job go pebble-beta/);
});

test('nudges are spaced out, and after the daily limit the manager is told once', () => {
  const once = nudged(job, 'nudge', now);
  assert.equal(decide(once, quiet, now + GAP_MS - 1), 'none');
  assert.equal(decide(once, quiet, now + GAP_MS), 'nudge');
  const many = { ...job, nudgeDay: localDay(new Date(now)), nudgesToday: MAX_NUDGES_PER_DAY };
  assert.equal(decide(many, quiet, now), 'stuck');
  assert.equal(decide(nudged(many, 'stuck', now), quiet, now + GAP_MS), 'none');
});

test('no session in the room: the manager is told to hand it over', () => {
  assert.equal(decide(job, undefined, now), 'no-session');
});

test('the nudge is one line and keeps the two rules: no emails sent, nothing posted without the owner', () => {
  const line = nudgeLine(job, '~/.tiny-hq/app/manager/job');
  assert.ok(!line.includes('\n'));
  assert.match(line, /never do: send an email/);
  assert.match(line, /public site .*the owner's yes for that exact text/);
  assert.match(line, /job done pebble-beta/);
});

test('bad jobs are refused', () => {
  assert.equal(validJob({ id: 'Bad Id', room: '/x', title: 't', done: 'd' }), undefined);
  assert.equal(validJob({ id: 'ok', room: 'relative', title: 't', done: 'd' }), undefined);
});

test('a new brief lists the sections the manager still has to fill in', async () => {
  const { briefTemplate, emptySections } = await import('../src/team/jobs.ts');
  const t = briefTemplate(job);
  assert.deepEqual(emptySections(t), ["The owner's words", 'Goal', 'What we know', 'Already done']);
  const filled = t.replace("## The owner's words\n", '## The owner\'s words\n"Get Pebble tested" (the manager\'s chat)\n');
  assert.ok(!emptySections(filled).includes("The owner's words"));
});

test('the nudge points the room at the brief', () => {
  assert.match(nudgeLine(job, 'cli', '/b/pebble-beta.md'), /read the job brief, \/b\/pebble-beta\.md/);
});

test("a job waiting on the room's own open question isn't checked every 15 minutes", async () => {
  const { decide, validJob, CHECK_MS } = await import('../src/team/jobs.ts');
  const now = new Date(2026, 10, 9, 16, 0).getTime();
  const waiting = validJob({ id: 'launch-posts', room: '/Users/g/Dev/atlas', title: 'Launch posts', done: 'posted', status: 'waiting', waitingFor: 'OK the X post', createdAt: 1, updatedAt: now - CHECK_MS - 1 })!;
  const quiet = { status: 'idle', state: 'done', lastActive: now - CHECK_MS - 1, viewed: false };
  assert.equal(decide(waiting, quiet, now), 'check');
  assert.equal(decide(waiting, quiet, now, true), 'none');
});
