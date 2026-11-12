import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookCommand, HOOKS, installedHooks, shellWord, withHooks, withoutHooks, writeSettings } from '../src/cli/install.ts';

test("hooks go in and come out without touching anything of the owner's", () => {
  const mine = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'opus' };
  const on = withHooks(mine, '/app', ['name-tag', 'public-posts']);
  assert.equal(installedHooks(on).length, 2);
  assert.equal(installedHooks(withHooks(on, '/app', ['name-tag', 'public-posts'])).length, 2, 'running setup twice adds nothing twice');
  assert.deepEqual(withoutHooks(on), mine, 'uninstall leaves exactly what was there');
  assert.deepEqual(withoutHooks({ model: 'x' }), { model: 'x' });
});

test('a hook path with spaces, $ or quotes stays one shell word', () => {
  for (const app of ['/Users/a b/.tiny-hq/app', '/Users/$HOME`x`/app', "/Users/o'neil/app"]) {
    const cmd = hookCommand(app, HOOKS[1]!).split('  #')[0]!;
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${cmd.replace(/^node /, '')}`], { encoding: 'utf8' }).trim();
    assert.equal(out, join(app, 'hooks', 'office-waiting.mjs'));
  }
  assert.equal(shellWord('/plain/path'), '/plain/path');
});

test("settings.json keeps its permissions, stays a link if it was one, and isn't rewritten when nothing changes", () => {
  const home = mkdtempSync(join(tmpdir(), 'thq-home-'));
  const dots = mkdtempSync(join(tmpdir(), 'thq-dots-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(dots, 'settings.json'), '{"model":"opus"}');
  chmodSync(join(dots, 'settings.json'), 0o600);
  symlinkSync(join(dots, 'settings.json'), join(home, '.claude', 'settings.json'));
  assert.equal(writeSettings({ model: 'opus' }, home), false, 'same content: not written');
  assert.equal(writeSettings(withHooks({ model: 'opus' }, '/app', ['waiting']), home), true);
  assert.ok(lstatSync(join(home, '.claude', 'settings.json')).isSymbolicLink(), 'the link is still a link');
  assert.match(readFileSync(join(dots, 'settings.json'), 'utf8'), /# tiny-hq waiting/);
  assert.equal(statSync(join(dots, 'settings.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(home, '.claude', 'settings.json.before-tiny-hq'), 'utf8'), '{"model":"opus"}', 'the original is kept once');
});
