import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error: a plain .mjs hook, no types
import { postingCommand } from '../hooks/public-post-guard.mjs';

const post = (cmd: string) => postingCommand(cmd) as string | undefined;

test('a post hidden in a command substitution is still a post, quoted or not', () => {
  for (const cmd of [
    'echo "$(gh pr comment 3 -b hi)"',
    'echo "`gh pr comment 3 -b hi`"',
    'x="$(echo a; gh issue create -t t -b b)"',
    'printf %s "prefix $(timeout 10 gh pr review 3 --comment -b ok)"',
    "bash -c 'echo \"$(gh pr comment 3 -b hi)\"'",
  ]) assert.ok(post(cmd), cmd);
});

test('only words the shell runs as programs count: a search or an echo that mentions gh is not a post', () => {
  for (const cmd of ['rg gh src', 'grep -rn "gh pr comment" .', 'echo gh issue create', 'git commit -m "teach gh pr comment"', 'ls gh', 'cat notes/gh'])
    assert.equal(post(cmd), undefined, cmd);
  for (const cmd of [
    'gh pr comment 3 -b x',
    'GH_REPO=o/r gh pr comment 3 -b x',
    '/opt/homebrew/bin/gh pr comment 3 -b x',
    'sudo -u me gh pr comment 3 -b x',
    'env A=1 gh issue create -t a -b b',
    'echo 3 | xargs -n 1 gh pr comment -b x',
    'for i in 1 2; do gh pr comment $i -b x; done',
    'timeout 10 gh issue create -t a -b b',
    'nohup gh gist create notes.md',
  ]) assert.ok(post(cmd), cmd);
});

// The pass lock: one just taken by another hook (its time not written yet) is never taken over, so
// one pass can't be used twice; a lock abandoned for over 10 s is.
test('a pass lock that was only just taken is respected; an abandoned one is taken over', async () => {
  const { mkdtempSync, mkdirSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { grantPass } = await import('../src/team/posts.ts');
  // @ts-expect-error: a plain .mjs hook, no types
  const pa = (await import('../hooks/post-approvals.mjs')) as { usePass: (t: string, s: string, now: number, p: string, cwd?: string, where?: unknown, target?: string) => boolean };
  const path = join(mkdtempSync(join(tmpdir(), 'cm-lock-')), 'passes.json');
  grantPass(path, 'hello', '/room', Date.now(), 'o/r#1');
  mkdirSync(`${path}.lock`); // another hook has just taken it
  assert.throws(() => pa.usePass('hello', 's', Date.now(), path, '/room', undefined, 'o/r#1'), /busy/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, old, old); // ...and then crashed long ago
  assert.equal(pa.usePass('hello', 's', Date.now(), path, '/room', undefined, 'o/r#1'), true);
});
