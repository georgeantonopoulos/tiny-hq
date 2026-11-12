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
