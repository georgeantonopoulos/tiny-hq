// The optional screen helper (tiny-hq screen on): a login agent running Peekaboo's daemon, built for
// whoever runs it, never with someone's home folder written in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCREEN_LABEL, screenPlist } from '../src/daemon/launchd.ts';

test('the screen helper runs Peekaboo for this home: its socket and log are under it', () => {
  const x = screenPlist('/opt/homebrew/bin/peekaboo', '/Users/ada');
  assert.match(x, new RegExp(`<string>${SCREEN_LABEL}</string>`));
  assert.match(x, /<string>\/opt\/homebrew\/bin\/peekaboo<\/string>\s*<string>daemon<\/string>\s*<string>run<\/string>/);
  assert.match(x, /<string>\/Users\/ada\/Library\/Application Support\/Peekaboo\/bridge\.sock<\/string>/);
  assert.match(x, /\/Users\/ada\/Library\/Logs\/tiny-hq-screen\.log/);
  assert.equal(screenPlist('/opt/homebrew/bin/peekaboo', '/Users/b&o').includes('b&amp;o'), true, 'escaped');
});

test('uninstall takes the screen helper out too, and rooms are told how to use it', () => {
  const cli = readFileSync(new URL('../src/cli/tiny-hq.ts', import.meta.url), 'utf8');
  assert.match(cli, /unloadAgent\(OPEN_LABEL\);\s*unloadAgent\(SCREEN_LABEL\);/);
  const skill = readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /A desktop app is tested only once you've seen it on screen/);
  assert.match(skill, /tiny-hq screen on/);
});
