// The quiet office: buttons only for money, public text or the irreversible; buttons expire after
// 2 days as "not now"; one evening note on the owner's desk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOnlyOwner, WHY_LIST } from '../src/team/only-owner.ts';
import { addEntry, ASK_TTL_MS, eveningDue, eveningNote, eveningPath, EXPIRED_HOLD_MS, expiredAsks, expiredLine, fileEvening, lastFiled, loadEntries, markFiled, restJobs } from '../src/team/evening.ts';
import { briefTemplate, nudgeLine, type Job } from '../src/team/jobs.ts';
import { stepLine } from '../src/team/autonomy.ts';
import type { Ask } from '../src/team/asks.ts';
// @ts-expect-error a plain-JS hook module, no type declarations
import { REASON } from '../hooks/room-ask-guard.mjs';

const H = 3_600_000;
const job = (o: Partial<Job>): Job => ({ id: 'j1', room: '/d/app', title: 'Ship it', done: 'shipped', status: 'active', createdAt: 0, updatedAt: 0, ...o });
const ask = (o: Partial<Ask>): Ask => ({ id: 'aaaaaaaa', folder: '/d/app', question: 'Merge PR #46?', createdAt: 0, ...o }) as Ask;

test('a room may ask the owner a choice on a button', () => {
  assert.equal(checkOnlyOwner('choice', 'compared the cloud key and the local API'), undefined);
  assert.match(checkOnlyOwner('choice', '') ?? '', /Missing --tried/);
  assert.equal(checkOnlyOwner('irreversible', 'deleting the old bucket loses 3 GB of renders'), undefined);
  assert.equal(checkOnlyOwner('pay', 'checked the price'), undefined);
});

test('a button up for 2 days comes down as "not now"; a trust button stays; its job rests a week', () => {
  const now = 10 * 24 * H;
  const old = ask({ id: 'oldoldol', createdAt: now - ASK_TTL_MS, job: 'j1' });
  const fresh = ask({ id: 'freshfre', createdAt: now - ASK_TTL_MS + 1 });
  const trust = ask({ id: 'trusttru', createdAt: 0, trust: { name: 'Sam', task: 'checks' } });
  const { left, expired } = expiredAsks([old, fresh, trust], now);
  assert.deepEqual(left.map((a) => a.id), ['freshfre', 'trusttru']);
  assert.deepEqual(expired.map((a) => a.id), ['oldoldol']);
  const [rested, other] = restJobs([job({ status: 'waiting', waitingFor: 'Merge PR #46' }), job({ id: 'j2', status: 'waiting' })], expired, now);
  assert.equal(rested!.status, 'active');
  assert.equal(rested!.waitingFor, undefined);
  assert.equal(rested!.holdUntil, now + EXPIRED_HOLD_MS);
  assert.match(rested!.holdFor!, /not now/);
  assert.equal(other!.status, 'waiting', 'a job with no expired button is untouched');
  const line = expiredLine(old);
  assert.match(line, /not now/);
  assert.match(line, /Job j1 rests for a week/);
  assert.ok(!line.includes('\n'));
});

test('the evening note: one page of what did not need the owner, nothing when there is nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'th-eve-'));
  const path = eveningPath(dir);
  const at = new Date(2026, 10, 15, 12).getTime();
  assert.equal(eveningNote([], [], 0, at, (f) => f), undefined);
  addEntry(path, { at, kind: 'decision', folder: '/d/app', text: 'Kept the old icon:\nthe new one blurs at 16px' });
  addEntry(path, { at, kind: 'merge', folder: '/d/site', text: 'Merged PR #12 (dependency bump)' });
  assert.equal(addEntry(path, { kind: 'nonsense' as never, folder: '/d', text: 'x' }), undefined);
  assert.equal(addEntry(path, { kind: 'note', folder: '/d', text: '   ' }), undefined);
  const entries = loadEntries(path);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.text, 'Kept the old icon: the new one blurs at 16px');
  const note = eveningNote(entries, [job({ status: 'done', updatedAt: at }), job({ id: 'old', status: 'done', updatedAt: 1 })], 100, at + 1, (f) => f.split('/').pop()!)!;
  assert.match(note.title, /^Evening note, 15 Nov: 1 job done, 1 decision, 1 merge$/);
  assert.match(note.markdown, /## Jobs finished\n\n- \*\*app\*\*: Ship it/);
  assert.match(note.markdown, /## Merged by a room\n\n- \*\*site\*\*: Merged PR #12/);
  assert.equal(eveningNote(entries, [], at, at + 1, (f) => f), undefined, 'only what came since the last note');
  // Filed once a day at 19:00.
  assert.equal(eveningDue(0, new Date(2026, 10, 15, 18, 59)), undefined);
  assert.equal(eveningDue(0, new Date(2026, 10, 15, 19, 1)), new Date(2026, 10, 15, 19).getTime());
  markFiled(dir, new Date(2026, 10, 15, 19, 1).getTime());
  assert.equal(eveningDue(lastFiled(dir), new Date(2026, 10, 15, 23)), undefined);
  assert.ok(eveningDue(lastFiled(dir), new Date(2026, 10, 16, 19, 5)));
});

test('manager/evening add files a line under the room, refuses an empty one and the office-only kind', () => {
  const data = mkdtempSync(join(tmpdir(), 'th-evecli-'));
  const room = realpathSync(mkdtempSync(join(tmpdir(), 'th-everoom-')));
  const cli = new URL('../src/cli/evening.ts', import.meta.url).pathname;
  const run = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', cli, ...a], { cwd: room, env: { ...process.env, CM_DATA_DIR: data, CLAUDE_CODE_SESSION_ID: '' }, encoding: 'utf8' });
  assert.equal(run('add', 'Picked', 'the', 'smaller', 'build').status, 0);
  assert.equal(run('add', 'Merged #12', '--kind', 'merge').status, 0);
  assert.equal(run('add').status, 2);
  assert.equal(run('add', 'x', '--kind', 'expired').status, 2);
  assert.equal(run('add', 'x', '--kind', 'bogus').status, 2);
  const rows = loadEntries(eveningPath(join(data, 'manager')));
  assert.deepEqual(rows.map((r) => [r.kind, r.text, r.folder]), [['decision', 'Picked the smaller build', room], ['merge', 'Merged #12', room]]);
  assert.match(run('list').stdout, /Picked the smaller build/);
});

test('rooms are told the same reasons everywhere, choice included: guard, nudge, brief, skill and goal step', () => {
  assert.ok(REASON.includes(`--why <${WHY_LIST}>`), 'the room question check names every reason');
  assert.match(REASON, /--choices/);
  assert.match(REASON, /manager\/evening add/);
  const nudge = nudgeLine(job({}), '/x/manager/job');
  assert.ok(nudge.includes(`--why <${WHY_LIST}>`));
  assert.match(nudge, /--why choice .*--choices/);
  assert.match(nudge, /evening add/);
  // The longest job a brief allows still gets every rule and the closing "done" step.
  const long = nudgeLine(job({ title: 'T'.repeat(120), done: 'D'.repeat(1200) }), '/Users/someone/.tiny-hq/app/manager/job');
  assert.match(long, /--why <[^>]*choice[^>]*>/);
  assert.match(long, /and report to the manager\.$/);
  const brief = briefTemplate({ id: 'j1', title: 'Ship it', done: 'shipped', room: '/d/app' });
  assert.match(brief, /--why choice --choices/);
  assert.doesNotMatch(brief, /Any other choice is yours/);
  const step = stepLine('Polish the app', 'week 62% used', '/x/manager/ask');
  assert.match(step, /\/x\/manager\/evening add .* --kind step/);
  assert.match(step, /--why choice/);
  assert.doesNotMatch(step, /SendMessage/);
  const skill = readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8');
  assert.ok(skill.includes(`--why <${WHY_LIST}>`), 'the skill names every reason');
  assert.match(skill, /--why choice .*--choices/);
  assert.match(skill, /manager\/evening add/);
  const delegate = readFileSync(new URL('../manager/delegate', import.meta.url), 'utf8');
  assert.match(delegate, /manager\/evening add/);
  assert.match(delegate, /--why choice/);
  const rules = readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8');
  assert.doesNotMatch(rules, /One next move for every room|next move toward <its goal>/);
  assert.match(rules, /evening list/);
});

test('every manager/ command can be run', () => {
  const dir = new URL('../manager/', import.meta.url).pathname;
  for (const f of readdirSync(dir)) {
    const st = statSync(join(dir, f));
    if (!st.isFile() || f.startsWith('.') || /\.(md|json|txt|log)$/.test(f)) continue;
    assert.ok(st.mode & 0o100, `manager/${f} is not executable`);
    assert.match(readFileSync(join(dir, f), 'utf8').slice(0, 2), /^#!/, `manager/${f} has no #! line`);
  }
});

// package.json lists manager commands one by one; one left out is missing for everyone who installs.
test('every manager/ command ships in the npm package', () => {
  const dir = new URL('../manager/', import.meta.url).pathname;
  const files = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] }).files;
  for (const f of readdirSync(dir)) {
    const st = statSync(join(dir, f));
    if (!st.isFile() || f.startsWith('.') || /\.(md|json|txt|log)$/.test(f)) continue;
    assert.ok(files.includes(`manager/${f}`) || files.includes('manager'), `manager/${f} is not in package.json "files"`);
  }
});

// The note was once marked filed before the page was written, so a failed write lost the day's entries.
test('a failed evening note is tried again next tick; marked filed only once it is on the desk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-evefile-'));
  const path = eveningPath(dir);
  addEntry(path, { at: new Date(2026, 10, 15, 12).getTime(), kind: 'decision', folder: '/d/app', text: 'Kept the old icon' });
  const at = new Date(2026, 10, 15, 19, 1).getTime();
  const filed: string[] = [];
  const said = fileEvening(dir, path, [], at, (f) => f, () => {
    throw new Error('disk full');
  });
  assert.match(said!, /could not file it/);
  assert.equal(lastFiled(dir), 0, 'not marked filed');
  assert.match(fileEvening(dir, path, [], at + 60_000, (f) => f, (t, md) => filed.push(t, md))!, /on the owner's desk/);
  assert.match(filed[1]!, /Kept the old icon/, 'same entries on the retry');
  assert.equal(lastFiled(dir), at + 60_000);
  assert.equal(fileEvening(dir, path, [], at + 120_000, (f) => f, () => assert.fail('filed twice')), undefined);
  // Nothing to say: marked, no page.
  const empty = mkdtempSync(join(tmpdir(), 'cm-evefile-'));
  assert.match(fileEvening(empty, eveningPath(empty), [], at, (f) => f, () => assert.fail('no page'))!, /nothing to say/);
  assert.equal(lastFiled(empty), at);
});

// From review: the Mac slept through the first 19:00; the next evening's note must still carry
// what was queued before it, and not every job ever finished.
test('the first evening note carries every queued entry, but finished jobs from one day only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-evefirst-'));
  const path = eveningPath(dir);
  addEntry(path, { at: new Date(2026, 10, 14, 10).getTime(), kind: 'decision', folder: '/d/app', text: 'Kept the old icon' });
  const at = new Date(2026, 10, 15, 19, 1).getTime();
  const job = (id: string, updatedAt: number) => ({ id, room: '/d/app', title: `job ${id}`, status: 'done', createdAt: updatedAt, updatedAt }) as unknown as Job;
  const filed: string[] = [];
  fileEvening(dir, path, [job('old', new Date(2026, 9, 1).getTime()), job('new', at - 3_600_000)], at, (f) => f, (t, md) => filed.push(md));
  assert.match(filed[0]!, /Kept the old icon/);
  assert.match(filed[0]!, /job new/);
  assert.doesNotMatch(filed[0]!, /job old/);
});
