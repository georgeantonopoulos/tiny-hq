// The optional screen helper: a login agent running Peekaboo's daemon, built for whoever runs it,
// never started at login; a room turns it on while it tests and the office stops it when time's up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCREEN_LABEL, screenPlist } from '../src/daemon/launchd.ts';
import { clearMarker, MAX_MINUTES, readMarker, shouldStop, writeMarker } from '../src/team/screen.ts';

test('the screen helper runs Peekaboo for this home, and never starts by itself', () => {
  const x = screenPlist('/opt/homebrew/bin/peekaboo', '/Users/ada');
  assert.match(x, new RegExp(`<string>${SCREEN_LABEL}</string>`));
  assert.match(x, /<string>\/opt\/homebrew\/bin\/peekaboo<\/string>\s*<string>daemon<\/string>\s*<string>run<\/string>/);
  assert.match(x, /<string>\/Users\/ada\/Library\/Application Support\/Peekaboo\/bridge\.sock<\/string>/);
  assert.match(x, /\/Users\/ada\/Library\/Logs\/tiny-hq-screen\.log/);
  assert.match(x, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(x, /<key>KeepAlive<\/key><false\/>/);
  assert.equal(screenPlist('/opt/homebrew/bin/peekaboo', '/Users/b&o').includes('b&amp;o'), true, 'escaped');
});

test('the office stops the helper when its time is up, or when nobody turned it on', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'screen-')), 'screen-on.json');
  const on = writeMarker(path, 'Pixel Pip', 30, 1_000);
  assert.equal(on.until, 1_000 + 30 * 60_000);
  assert.deepEqual(readMarker(path), on);
  assert.equal(shouldStop(true, on, 1_000 + 29 * 60_000), false, 'still in its time');
  assert.equal(shouldStop(true, on, on.until), true, 'time up');
  assert.equal(shouldStop(true, undefined), true, 'running with nobody having turned it on');
  assert.equal(shouldStop(false, undefined), false, 'already off');
  assert.equal(writeMarker(path, 'x', 10_000, 0).until, MAX_MINUTES * 60_000, 'capped');
  assert.equal(writeMarker(path, 'x', 5, 0, 4242).awake, 4242);
  assert.equal(readMarker(path)!.awake, 4242, 'the caffeinate pid is kept so it can be stopped with the helper');
  clearMarker(path);
  assert.equal(readMarker(path), undefined);
});

test('uninstall takes the screen helper out too, and rooms are told to turn it on only while testing', () => {
  const cli = readFileSync(new URL('../src/cli/tiny-hq.ts', import.meta.url), 'utf8');
  assert.match(cli, /unloadAgent\(OPEN_LABEL\);\s*unloadAgent\(SCREEN_LABEL\);/);
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  assert.match(main, /tidyScreen\(DATA_DIR\)/, "the office's regular check stops it");
  const skill = readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /A desktop app is tested only once you've seen it on screen/);
  assert.match(skill, /manager\/screen on/);
  assert.match(skill, /--window-id/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('manager/screen'), 'the rooms\' screen command ships');
});

test("a locked Mac: screen on wakes the display and puts a 'hands' unlock button over the room", () => {
  const cli = readFileSync(new URL('../src/cli/screen.ts', import.meta.url), 'utf8');
  assert.match(cli, /if \(macLocked\(\)\) askToUnlock\(/);
  assert.match(cli, /'\/usr\/bin\/caffeinate', \['-u', '-t', '5'\]/);
  assert.match(cli, /join\(REPO_ROOT, 'manager', 'ask'\)[\s\S]*'--why',\s*'hands'/);
  assert.doesNotMatch(cli, /cwd:/, 'the button goes up from the room folder the command runs in');
});

test('a click waits for 30 s without keyboard or mouse, unless the last input was a room click', async () => {
  const { stillEnough, STILL_MS } = await import('../src/team/screen.ts');
  const now = 1_000_000;
  assert.equal(STILL_MS, 30_000);
  assert.equal(stillEnough(2_000, now), false, 'the owner touched it 2 s ago');
  assert.equal(stillEnough(29_999, now), false);
  assert.equal(stillEnough(30_000, now), true);
  // A room clicked 5 s ago and that was the last event: the owner hasn't touched it since.
  assert.equal(stillEnough(5_000, now, now - 5_000), true);
  assert.equal(stillEnough(5_100, now, now - 5_000), true, 'ioreg read a moment later');
  // The owner moved the mouse 1 s ago, after the room's click 10 s ago.
  assert.equal(stillEnough(1_000, now, now - 10_000), false);
  // The owner moved it 500 ms after the room's last event: that is theirs, not the room's.
  assert.equal(stillEnough(500, now, now - 1_000), false);
});

test('peekaboo input run directly is sent through manager/screen; looking is not', async () => {
  // @ts-expect-error a plain-JS hook module, no type declarations
  const { directInput, decideScreen } = (await import('../hooks/screen-click-guard.mjs')) as { directInput: (c: string) => string | undefined; decideScreen: (t: string, i: unknown) => string | undefined };
  const pb = 'peekaboo';
  assert.equal(directInput(`${pb} click --coords 336,826`), 'click');
  assert.equal(directInput(`cd /tmp && ${pb} click --coords 1,2 >/dev/null; sleep 1`), 'click');
  assert.equal(directInput(`/opt/homebrew/bin/${pb} type "1"`), 'type');
  assert.equal(directInput(`X=1 ${pb} hotkey --keys cmd,s`), 'hotkey');
  assert.equal(directInput(`echo $(${pb} scroll --direction down)`), 'scroll');
  assert.equal(directInput(`${pb} app switch --to Atlas`), 'app');
  assert.equal(directInput(`for i in 1 2; do ${pb} click --coords 10,10; done`), 'click', 'inside a loop');
  assert.equal(directInput(`if true; then ${pb} type "a"; fi`), 'type');
  assert.equal(directInput(`{ ${pb} click --coords 1,1; }`), 'click');
  assert.equal(directInput(`nohup ${pb} click --coords 1,1`), 'click');
  assert.equal(directInput(`bash -c "${pb} click --coords 1,1"`), 'click');
  assert.equal(directInput(`timeout 5 ${pb} scroll --direction up`), 'scroll');
  assert.equal(directInput(`${pb} image --window-id 6443 --path a.png`), undefined);
  assert.equal(directInput(`${pb} see --app Atlas`), undefined);
  assert.equal(directInput(`${pb} list windows --app atlas`), undefined);
  assert.equal(directInput(`${pb} app list`), undefined);
  assert.equal(directInput(`${pb} permissions`), undefined);
  assert.equal(directInput('~/.tiny-hq/app/manager/screen click --coords 336,826'), undefined);
  assert.match(decideScreen('Bash', { command: `${pb} click --coords 1,2` })!, /manager\/screen click/);
  assert.equal(decideScreen('Read', { command: `${pb} click` }), undefined);
  // The CLI drives the same verbs the guard refuses, so a refused command always has a way through.
  const cli = readFileSync(new URL('../src/cli/screen.ts', import.meta.url), 'utf8');
  assert.match(cli, /INPUT_VERBS\.includes\(cmd\)/);
});

test('the click guard is one of the hooks setup offers, and only acts in rooms', async () => {
  const { HOOKS } = await import('../src/cli/install.ts');
  const h = HOOKS.find((x) => x.id === 'screen-clicks');
  assert.equal(h?.event, 'PreToolUse');
  assert.equal(h?.file, 'screen-click-guard.mjs');
  const hook = readFileSync(new URL('../hooks/screen-click-guard.mjs', import.meta.url), 'utf8');
  assert.match(hook, /why && isRoom\(/);
});
