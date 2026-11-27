import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathOf, revealArgs } from '../src/daemon/reveal.ts';
import { isPath, LINK_RE } from '../web/app/term-links.ts';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'reveal-home-')));
mkdirSync(join(home, 'Code', 'Foo.app'), { recursive: true });
writeFileSync(join(home, 'Code', 'shot.png'), 'x');

test('written paths: ~, file:// and absolute; nothing relative', () => {
  assert.equal(pathOf('~/Code/a b.png', '/H'), '/H/Code/a b.png');
  assert.equal(pathOf('file:///Users/g/a%20b.txt', '/H'), '/Users/g/a b.txt');
  assert.equal(pathOf('/tmp/x/', '/H'), '/tmp/x');
  assert.equal(pathOf('Dev/x', '/H'), undefined);
});

test('a folder opens, a file or an app is only selected in Finder', () => {
  assert.deepEqual(revealArgs('~/Code', home), [join(home, 'Code')]);
  assert.deepEqual(revealArgs('~/Code/shot.png', home), ['-R', join(home, 'Code', 'shot.png')]);
  assert.deepEqual(revealArgs('~/Code/Foo.app', home), ['-R', join(home, 'Code', 'Foo.app')], 'an app is never launched');
});

test('a path that is gone lands on its nearest folder; outside the allowed places is refused', () => {
  assert.deepEqual(revealArgs('~/Code/gone/later.png', home), [join(home, 'Code')]);
  assert.equal(revealArgs('/etc/hosts', home), undefined);
  assert.equal(revealArgs('/System/Applications/Calculator.app', home), undefined);
});

test('paths in text are found, URLs stay URLs, and words with slashes are not paths', () => {
  const t = 'before /tmp/hdr-before.png, after ~/Code/x/y.png. See https://a.com/Users/x and file:///Users/g/a.txt; abc/Users/no (/Volumes/Disk/f).';
  assert.deepEqual([...t.matchAll(LINK_RE)].map((m) => [m[0], isPath(m[0])]), [
    ['/tmp/hdr-before.png', true],
    ['~/Code/x/y.png', true],
    ['https://a.com/Users/x', false],
    ['file:///Users/g/a.txt', true],
    ['/Volumes/Disk/f', true],
  ]);
});

test('wiring: bubbles, button text and the chat panel all reveal paths; the daemon serves it on the Mac only', () => {
  const bubbles = readFileSync('web/app/bubbles.ts', 'utf8');
  assert.match(bubbles, /linkify\(q, ask\.question\)/);
  assert.match(bubbles, /linkify\(t, `\$\{ask\.hands/);
  assert.match(bubbles, /matchAll\(LINK_RE\)/);
  assert.match(readFileSync('web/app/main.ts', 'utf8'), /onReveal\(/);
  assert.match(readFileSync('web/app/terminal.ts', 'utf8'), /isPath\(l\.text\) \? void api\.reveal/);
  const server = readFileSync('src/daemon/server.ts', 'utf8');
  assert.match(server, /\/api\/reveal' && deps\.reveal\) \{\s*if \(remote\) return send\(res, 403/);
  assert.match(readFileSync('src/daemon/main.ts', 'utf8'), /^\s*reveal,$/m);
});
