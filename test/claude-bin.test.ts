// Which Claude Code the office runs. The office runs claude with the login shell's PATH, which can
// list an old copy first (an outdated Homebrew one); the office must use the same one setup checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClaude } from '../src/paths.ts';

const base = mkdtempSync(join(tmpdir(), 'th-claude-bin-'));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const bin = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'claude');
  writeFileSync(f, '#!/bin/sh\n');
  chmodSync(f, 0o755);
  return f;
};

test("Claude Code's own install in ~/.local/bin wins over an older one earlier on the PATH", () => {
  const home = join(base, 'a');
  const brew = bin(join(base, 'a-brew'));
  const native = bin(join(home, '.local', 'bin'));
  assert.equal(findClaude(home, `${join(base, 'a-brew')}:/usr/bin`), native);
  assert.notEqual(native, brew);
});

test('without ~/.local/bin/claude, the first claude on the PATH, as a full path', () => {
  const home = join(base, 'b');
  const first = bin(join(base, 'b-one'));
  bin(join(base, 'b-two'));
  assert.equal(findClaude(home, `${join(base, 'b-none')}:${join(base, 'b-one')}:${join(base, 'b-two')}`), first);
});

test('a folder called claude or a file that is not executable is skipped; nothing found falls back to the name', () => {
  const home = join(base, 'c');
  mkdirSync(join(home, '.local', 'bin', 'claude'), { recursive: true });
  const plain = join(base, 'c-plain');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'claude'), 'not a program');
  assert.equal(findClaude(home, plain), 'claude');
});
