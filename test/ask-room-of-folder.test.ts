import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normRemote, roomOfFolder, roomOfSession } from '../src/office/room-of-folder.ts';

const SID = '0b5c2d1e-1111-4222-8333-944455556666';
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function world() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'room-of-')));
  const notes = join(top, 'Dev', 'notes');
  const editor = join(top, 'Dev', 'editor');
  for (const r of [notes, editor]) {
    mkdirSync(r, { recursive: true });
    git(r, 'init', '-q');
    git(r, 'commit', '-q', '--allow-empty', '-m', 'x');
  }
  git(notes, 'remote', 'add', 'origin', 'git@github.com:Someone/notes-app.git');
  return { top, notes, editor };
}

// A button raised from a worktree of a room kept outside .claude/worktrees must still show over that room.
test('a worktree of a room kept anywhere on disk belongs to that room', () => {
  const { top, notes, editor } = world();
  const outside = join(top, '.tools', 'skills', 'a-skill');
  mkdirSync(join(top, '.tools', 'skills'), { recursive: true });
  git(notes, 'worktree', 'add', '-q', outside);
  assert.equal(roomOfFolder(outside, [editor, notes]), notes);
});

test('a separate clone with the same GitHub remote belongs to that room', () => {
  const { top, notes, editor } = world();
  const clone = join(top, 'elsewhere', 'notes-copy');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q');
  git(clone, 'remote', 'add', 'origin', 'https://github.com/someone/notes-app');
  assert.equal(roomOfFolder(clone, [editor, notes]), notes);
});

test('a folder inside a room, or in the deepest nested room, belongs to it', () => {
  const { notes, editor } = world();
  const nested = join(notes, 'plugins', 'inner');
  mkdirSync(nested, { recursive: true });
  assert.equal(roomOfFolder(join(notes, 'plugins'), [editor, notes, nested]), notes);
  assert.equal(roomOfFolder(join(nested, 'src'), [editor, notes, nested]), nested);
  assert.equal(roomOfFolder(join(notes, '.claude', 'worktrees', 'w'), [editor, notes]), notes);
});

test('a folder that matches no room belongs to none', () => {
  const { top, notes, editor } = world();
  const stray = join(top, 'Downloads', 'thing');
  mkdirSync(stray, { recursive: true });
  assert.equal(roomOfFolder(stray, [editor, notes]), undefined);
  const otherRepo = join(top, 'other');
  mkdirSync(otherRepo);
  git(otherRepo, 'init', '-q');
  assert.equal(roomOfFolder(otherRepo, [editor, notes]), undefined);
});

test('remotes compare by host/owner/repo, whatever the form', () => {
  assert.equal(normRemote('git@github.com:A/B.git'), 'github.com/a/b');
  assert.equal(normRemote('https://github.com/a/b'), 'github.com/a/b');
  assert.equal(normRemote('ssh://git@github.com/A/b.git/'), 'github.com/a/b');
});

test('ask refuses a folder that is no room, and files a worktree button under its room', () => {
  const { top, notes, editor } = world();
  const data = join(top, 'data');
  mkdirSync(join(data, 'manager'), { recursive: true });
  execFileSync('sh', ['-c', `printf '%s' '${JSON.stringify({ seated: [notes, editor], away: [] })}' > ${join(data, 'floor.json')}`]);
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'ask.ts');
  const ask = (cwd: string) =>
    spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', cli, 'Merge it?', '--why', 'pay', '--tried', 'ran the tests and checked the page', '--choices', 'Yes', 'Not yet'], { cwd, encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: data, CLAUDE_CODE_SESSION_ID: SID } });
  const stray = join(top, 'stray');
  mkdirSync(stray);
  const no = ask(stray);
  assert.equal(no.status, 2);
  assert.match(no.stderr, /isn't a room on the office floor/);
  const wt = join(top, 'wt-outside');
  git(notes, 'worktree', 'add', '-q', wt);
  const yes = ask(wt);
  assert.equal(yes.status, 0, yes.stderr);
  const saved = JSON.parse(readFileSync(join(data, 'manager', 'asks.json'), 'utf8'));
  const list = Array.isArray(saved) ? saved : saved.asks;
  assert.equal(list.length, 1);
  assert.equal(list[0].folder, notes);
  assert.equal(list[0].sessionId, SID);
  assert.equal(list[0].from, wt, 'an approved post\'s pass is for the folder the asker ran from');
});

test("a session's button goes over the room it was started in, wherever it runs ask from", () => {
  const { top, notes, editor } = world();
  const projects = join(top, 'projects');
  mkdirSync(join(projects, notes.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  writeFileSync(join(projects, notes.replace(/[^a-zA-Z0-9]/g, '-'), `${SID}.jsonl`), '');
  assert.equal(roomOfSession(SID, [editor, notes], projects), notes);
  assert.equal(roomOfSession('0b5c2d1e-0000-4222-8333-944455556666', [editor, notes], projects), undefined);
  assert.equal(roomOfSession('../../etc', [editor, notes], projects), undefined);
});

test('ask --room <worktree of a room> files the button under the room, and cancel with the same path takes it down', () => {
  const { top, notes, editor } = world();
  const data = join(top, 'data');
  mkdirSync(join(data, 'manager'), { recursive: true });
  writeFileSync(join(data, 'floor.json'), JSON.stringify({ seated: [notes, editor], away: [] }));
  const wt = join(notes, '.claude', 'worktrees', 'w');
  mkdirSync(join(notes, '.claude', 'worktrees'), { recursive: true });
  git(notes, 'worktree', 'add', '-q', wt);
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'ask.ts');
  const run = (...a: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', cli, ...a], { cwd: top, encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: data, CLAUDE_CODE_SESSION_ID: SID } });
  const put = run('--room', wt, 'Merge it?', '--why', 'pay', '--tried', 'ran the tests and checked the page', '--choices', 'Yes', 'Not yet');
  assert.equal(put.status, 0, put.stderr);
  const asks = () => {
    const s = JSON.parse(readFileSync(join(data, 'manager', 'asks.json'), 'utf8'));
    return Array.isArray(s) ? s : s.asks;
  };
  assert.equal(asks()[0].folder, notes);
  const off = run('--room', wt, 'cancel');
  assert.equal(off.status, 0, off.stderr);
  assert.equal(asks().length, 0);
  const stray = join(top, 'stray2');
  mkdirSync(stray);
  assert.equal(run('--room', stray, 'Q?', '--why', 'pay', '--tried', 'ran the tests and checked the page', '--choices', 'A', 'B').status, 2);
});
