import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAsk, answerLine, jobAnswered, oldestPerFolder, oneQuestionPerJob, validAsk } from '../src/team/asks.ts';
import { queuedAfter } from '../src/terminal/queued.ts';

test('a folder can have several open questions: a new one joins, the same one again refreshes, past five the oldest goes', () => {
  let asks = addAsk([], '/Users/g/Dev/Watch Face', 'Publish the closed-testing release?', 1, 'aaaaaaaa');
  asks = addAsk(asks, '/Users/g/Dev/Lumen', 'Ship 1.5?', 2, 'bbbbbbbb');
  asks = addAsk(asks, '/Users/g/Dev/Watch Face', 'Roll it out to 100%?', 3, 'cccccccc');
  // The second Watch Face question no longer wipes the first (the manager's second ask erased their first).
  assert.deepEqual(asks.map((a) => a.question).sort(), ['Publish the closed-testing release?', 'Roll it out to 100%?', 'Ship 1.5?']);
  asks = addAsk(asks, '/Users/g/Dev/Watch Face', 'Roll it out to 100%?', 4, 'dddddddd');
  assert.equal(asks.filter((a) => a.folder.endsWith('Watch Face')).length, 2);
  for (let i = 0; i < 6; i++) asks = addAsk(asks, '/Users/g/Dev/Lumen', `Q${i}?`, 10 + i, `q${i}aaaaaa`);
  assert.equal(asks.filter((a) => a.folder.endsWith('Lumen')).length, 5);
  assert.ok(!asks.some((a) => a.question === 'Ship 1.5?'));
});

test('the floor shows each folder\'s newest question and how many older ones wait behind it', () => {
  let asks = addAsk([], '/g', 'First?', 1, 'aaaaaaaa');
  asks = addAsk(asks, '/g', 'Second?', 2, 'bbbbbbbb');
  asks = addAsk(asks, '/other', 'Other?', 3, 'cccccccc');
  const shown = oldestPerFolder(asks);
  assert.deepEqual(shown.map((s) => [s.ask.question, s.more]).sort(), [['Other?', 0], ['Second?', 1]]);
  // Once the newest is answered, the older one takes its place.
  assert.equal(oldestPerFolder(asks.filter((a) => a.question !== 'Second?')).find((s) => s.ask.folder === '/g')!.ask.question, 'First?');
});

test('the typed answer is one line and says where it came from', () => {
  const a = validAsk({ id: 'aaaaaaaa', folder: '/x', question: 'Publish?\nnow', createdAt: 1 })!;
  assert.equal(a.question, 'Publish? now');
  const yes = answerLine(a, true)!;
  assert.ok(!yes.includes('\n'));
  assert.match(yes, /^The owner: yes/);
  assert.match(yes, /clicked Approve/);
  assert.match(answerLine(a, false)!, /^The owner: no/);
});

test('bad questions are refused', () => {
  assert.equal(validAsk({ id: 'aaaaaaaa', folder: 'relative', question: 'q' }), undefined);
  assert.equal(validAsk({ id: 'aaaaaaaa', folder: '/x', question: '   ' }), undefined);
  assert.equal(validAsk({ id: 'BAD', folder: '/x', question: 'q' }), undefined);
});

test('an ask remembers which session asked, so the answer goes back to it', () => {
  const [a] = addAsk([], '/x', 'Go?', 1, 'aaaaaaaa', '4e57e00a-b543-4431-993f-166f41737e7f');
  assert.equal(a!.sessionId, '4e57e00a-b543-4431-993f-166f41737e7f');
  assert.equal(addAsk([], '/x', 'Go?', 1, 'aaaaaaaa', 'not-a-session')[0]!.sessionId, undefined);
});

test('a job ask: Approve tells the room to do it now and that the job is active', () => {
  const [a] = addAsk([], '/Users/g/Dev/tiny-hq', 'Run: claude stop a1c22a9f', 1, 'abcdef12', undefined, 'close-stale');
  assert.equal(a!.job, 'close-stale');
  assert.match(answerLine(a!, true)!, /do it yourself now: "Run: claude stop a1c22a9f"/);
  assert.match(answerLine(a!, true)!, /job close-stale/);
  assert.match(answerLine(a!, false)!, /No/);
  assert.equal(validAsk({ ...a, job: 'Bad Id!' })!.job, undefined);
});

test('a multiple-choice question: the owner picks one option, and only a fitting answer is accepted', () => {
  const [a] = addAsk([], '/Users/g/Dev/Lumen', 'Which build goes to testers?', 1, 'mmmmmmmm', undefined, undefined, ['1.5 now', '1.5.1 next week', 'Hold']);
  assert.deepEqual(a!.options, ['1.5 now', '1.5.1 next week', 'Hold']);
  assert.match(answerLine(a!, { choice: 1 })!, /^The owner chose: "1\.5\.1 next week"/);
  assert.match(answerLine(a!, { choice: 1 })!, /"1\.5 now", "Hold"/);
  assert.equal(answerLine(a!, { choice: 3 }), undefined, 'out of range');
  assert.equal(answerLine(a!, true), undefined, 'a choice question takes a choice, not yes/no');
  const [yn] = addAsk([], '/g', 'Ship?', 1, 'nnnnnnnn');
  assert.equal(answerLine(yn!, { choice: 0 }), undefined, 'a yes/no question takes yes/no');
  // Fewer than two distinct options (or more than six) is a plain yes/no question; job asks never have options.
  assert.equal(validAsk({ id: 'aaaaaaaa', folder: '/g', question: 'Q?', options: ['One', 'one'] })!.options, undefined);
  assert.equal(validAsk({ id: 'aaaaaaaa', folder: '/g', question: 'Q?', options: ['1', '2', '3', '4', '5', '6', '7'] })!.options, undefined);
  assert.equal(validAsk({ id: 'aaaaaaaa', folder: '/g', question: 'Q?', job: 'x', options: ['A', 'B'] })!.options, undefined);
});

// `job wait` put a second button over a room that already had its own question
// (palette-tool: the room's three-way choice plus "Pick an answer on the room's question"),
// so the owner saw two per room and answering one left the other.
test('a job waiting on the owner rides on the room\'s own question instead of adding a second button', () => {
  let asks = addAsk([], '/g/palette', 'Post the reply on #4?', 1, 'roomaaaa', undefined, undefined, ['Post it', 'Test first', "Don't post"]);
  asks = addAsk(asks, '/g/palette', 'Pick an answer on the room\'s question', 2, 'jobaaaaa', undefined, 'palette-v17');
  assert.deepEqual(asks.map((a) => [a.id, a.forJob]), [['roomaaaa', 'palette-v17']]);
  assert.equal(oldestPerFolder(asks)[0]!.more, 0);
  // Any answer to it puts the job back to work; the room's question keeps its choices.
  assert.equal(jobAnswered(asks[0]!, { choice: 2 }), 'palette-v17');
  assert.deepEqual(asks[0]!.options, ['Post it', 'Test first', "Don't post"]);
  // A job's own button (no room question) still needs Approve.
  const own = addAsk([], '/g/lumen', 'Approve the reply?', 1, 'jobbbbbb', undefined, 'lumen-zip');
  assert.equal(own.length, 1);
  assert.equal(jobAnswered(own[0]!, { yes: true }), 'lumen-zip');
  assert.equal(jobAnswered(own[0]!, { yes: false }), undefined);
  // A plain room question with no job puts nothing back to work.
  assert.equal(jobAnswered(addAsk([], '/g/x', 'Ok?', 1, 'plainaaa')[0]!, { yes: true }), undefined);
});

test('doubles already on file fold into one, and a second job in the same room keeps its own button', () => {
  const file = [
    { id: 'qdco9c7d', folder: '/g/Lumen', question: 'Post this reply on lumen-releases #1?', createdAt: 1, sessionId: 'ed457897-d314-4dfb-87e2-78897ada8508' },
    { id: 'xp0i9eed', folder: '/g/Lumen', question: 'Approve or decline posting the reply', createdAt: 2, job: 'lumen-zip-perms' },
    { id: 'other000', folder: '/g/Lumen', question: 'Send the email?', createdAt: 3, job: 'lumen-email' },
  ].map((a) => validAsk(a)!);
  const folded = oneQuestionPerJob(file);
  assert.deepEqual(folded.map((a) => [a.id, a.forJob ?? a.job]), [['qdco9c7d', 'lumen-zip-perms'], ['other000', 'lumen-email']]);
  // Saved and loaded again: the link survives.
  assert.equal(validAsk(JSON.parse(JSON.stringify(folded[0])))!.forJob, 'lumen-zip-perms');
});

// the owner picked an option while the manager was busy. Claude Code queued it and wrote the
// line to the transcript only 29 s later; the office stopped looking after 15 s, called it
// failed and put the question back, though the manager had it.
test('a line typed into a busy session counts as landed once Claude Code queues it', () => {
  const old = '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-09T07:28:10.725Z"}\n';
  const mine = '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-09T07:28:11.423Z","sessionId":"89e4"}\n';
  const other = '{"type":"assistant","message":{"content":"working"}}\n';
  assert.equal(queuedAfter(old + other, Buffer.byteLength(old)), false); // queued before our Enter: someone else's
  assert.equal(queuedAfter(old + other + mine, Buffer.byteLength(old)), true);
  assert.equal(queuedAfter(other + '{"type":"queue-operation","operation":"dequeue"}\n', 0), false);
});

// A room asked three things from its worktree, then put the matching three job waits on the
// project itself: the owner saw six buttons for three questions.
test("job waits ride on the room's own questions asked from its worktree, each on the one it matches", () => {
  const wt = '/g/Lumen/.claude/worktrees/sidecar-proto';
  const sid = 'ce9a86ac-887b-4110-af74-c88217d4e935';
  const file = [
    { id: 'e871icd4', folder: wt, sessionId: sid, createdAt: 1, question: 'Lumen: may I post "@codex review" on PR #43 so Codex checks the fix for its last finding?' },
    { id: '4d5m566a', folder: wt, sessionId: sid, createdAt: 2, question: 'Lumen: may I post "@codex review" on PR #44 so Codex checks the fix for transparent black?' },
    { id: 'k3s5jxlx', folder: wt, sessionId: sid, createdAt: 3, question: 'Lumen: may I open the Linux-crash PR (fix/linux-ci-crash into main) with this description?' },
    { id: 'dydluhyb', folder: '/g/Lumen', createdAt: 4, job: 'lumen-linux-ci-crash', question: 'Approve opening the Linux-fix PR (fix/linux-ci-crash into main) with the title on the button' },
    { id: '2o1fhz0t', folder: '/g/Lumen', createdAt: 5, job: 'lumen-sidecar-v1', question: 'Approve posting "@codex review" on PR #43 so Codex checks the last fix' },
    { id: 'p1sxewfv', folder: '/g/Lumen', createdAt: 6, job: 'lumen-colour-bugs-1-3', question: 'Approve posting "@codex review" on PR #44 so Codex checks the transparent-black fix' },
    { id: 'elsewher', folder: '/g/Other', createdAt: 7, job: 'other-job', question: 'Approve posting on PR #43' },
  ].map((a) => validAsk(a)!);
  const folded = oneQuestionPerJob(file);
  assert.deepEqual(folded.map((a) => [a.id, a.forJob ?? a.job]), [
    ['e871icd4', 'lumen-sidecar-v1'],
    ['4d5m566a', 'lumen-colour-bugs-1-3'],
    ['k3s5jxlx', 'lumen-linux-ci-crash'],
    ['elsewher', 'other-job'],
  ]);
  // Folding again changes nothing, and a fourth job wait in the room keeps its own button.
  assert.deepEqual(oneQuestionPerJob(folded), folded);
  const more = addAsk(folded, '/g/Lumen', 'Approve the release', 8, 'fourthjb', undefined, 'lumen-release');
  assert.equal(more.filter((a) => a.job === 'lumen-release').length, 1);
});

// The Approve line used to quote the question's wording as the text to post,
// while the pass is for the exact --text.
test('a post Approve quotes the exact --text the pass is for, not the question', () => {
  const ask = validAsk({ id: 'postaaaa', folder: '/g/Lumen', question: 'Lumen: may I post "@codex review" on PR #43 so Codex checks the fix?', createdAt: 1, why: 'post', post: '@codex review' })!;
  const yes = answerLine(ask, { yes: true })!;
  assert.match(yes, /post exactly this: "@codex review"\./);
  assert.match(answerLine(ask, { yes: false })!, /don't post it: "@codex review"\./);
});
