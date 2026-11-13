import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrusted, trustFolder } from '../src/terminal/trust.ts';
import { addAsk, answerLine, loadAsks, validAsk } from '../src/team/asks.ts';

// delegate would fail with "Workspace not trusted" for a folder Claude Code hasn't trusted, and
// nothing could fix it from the office. Now the owner gets "Trust and start", and their Approve trusts it.
test('trust: a folder or one above it counts; trusting one keeps everything else in the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-trust-'));
  const file = join(dir, 'claude.json');
  writeFileSync(file, JSON.stringify({ numStartups: 9, projects: { '/a': { hasTrustDialogAccepted: true }, '/b': { allowedTools: ['x'] } } }));
  chmodSync(file, 0o600);
  assert.equal(isTrusted('/a', file), true);
  assert.equal(isTrusted('/a/deep/folder', file), false, "a trusted parent isn't enough for a background session");
  assert.equal(isTrusted('/a/', file), true);
  assert.equal(isTrusted('/b', file), false);
  assert.equal(isTrusted('/Volumes/Macintosh HD/x', file), false);
  trustFolder('/b', file);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after.projects['/b'], { allowedTools: ['x'], hasTrustDialogAccepted: true });
  assert.equal(after.numStartups, 9);
  assert.equal(isTrusted('/b', file), true);
  assert.throws(() => trustFolder('relative', file));
  assert.equal(isTrusted('/a', join(dir, 'missing.json')), false);
});

test('trust: the button carries the hand-off, and its answer line says what the office did', () => {
  let asks = addAsk([], '/v/Orbit', 'Trust Dev_OLD/Orbit and start Orbit?', 1, 'trustaaa', '11111111-2222-4333-8444-555555555555', undefined, undefined, true, { name: 'Orbit', task: 'Take the site offline.\nThen report.' });
  const a = validAsk(JSON.parse(JSON.stringify(asks[0])))!;
  assert.deepEqual(a.trust, { name: 'Orbit', task: 'Take the site offline.\nThen report.' });
  assert.match(answerLine(a, { yes: true })!, /marked \/v\/Orbit trusted .* started Orbit's session/);
  assert.match(answerLine(a, { yes: false })!, /No session was started/);
  assert.equal(answerLine(a, { choice: 0 }), undefined);
  asks = addAsk(asks, '/v/x', 'q?', 2, 'badtrust', undefined, undefined, undefined, false, { name: '', task: 'x' });
  assert.equal(asks.find((x) => x.id === 'badtrust')!.trust, undefined);
});

test('trust: delegate in an untrusted folder puts up the button instead of starting claude', () => {
  const home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  const data = mkdtempSync(join(tmpdir(), 'cm-data-'));
  const room = realpathSync(mkdtempSync(join(tmpdir(), 'cm-room-')));
  mkdirSync(join(data, 'manager'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: {} }));
  const fake = join(home, 'fake-claude');
  writeFileSync(fake, '#!/bin/sh\necho started > "$HOME/started"\n');
  chmodSync(fake, 0o755);
  const delegate = new URL('../manager/delegate', import.meta.url).pathname;
  const env = { ...process.env, HOME: home, CM_DATA_DIR: data, CM_CLAUDE_BIN: fake, CLAUDE_CODE_SESSION_ID: '11111111-2222-4333-8444-555555555555' };
  const r = spawnSync(delegate, [room, 'Orbit', 'Take it offline'], { env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /Trust and start/);
  const [a] = loadAsks(join(data, 'manager', 'asks.json'));
  assert.equal(a!.folder, room);
  assert.deepEqual(a!.trust, { name: 'Orbit', task: 'Take it offline' });
  assert.throws(() => readFileSync(join(home, 'started')), 'claude was not started');
  // Once trusted, delegate starts the session as before.
  trustFolder(room, join(home, '.claude.json'));
  execFileSync(delegate, [room, 'Orbit', 'Take it offline'], { env });
  assert.equal(readFileSync(join(home, 'started'), 'utf8').trim(), 'started');
});

// A new owner's rooms are usually folders Claude Code hasn't trusted, and the first click on one failed
// with "run claude there and accept the trust prompt". The room panel now asks, and only that click trusts.
test('trust: a Mac where Claude Code never wrote its settings file gets one, private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-trust-new-'));
  const file = join(dir, 'claude.json');
  trustFolder('/Users/x/Dev/app', file);
  assert.equal(isTrusted('/Users/x/Dev/app', file), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, '{ not json');
  assert.throws(() => trustFolder('/Users/x/Dev/other', file), 'a broken file is never overwritten');
});

test('trust: opening a room trusts the folder only on the trust click, and never for a running session', () => {
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  const at = main.indexOf('async function openTerminal(');
  assert.ok(at > 0);
  const block = main.slice(at, main.indexOf('\n}\n', at));
  assert.match(block, /if \(!live && !isManager && !isTrusted\(projectPath\)\) \{\s*if \(!trust\) throw [^\n]*trust: true \}\);\s*trustFolder\(projectPath\);/);
  assert.equal(block.match(/trustFolder\(/g)?.length, 1);
});

test('trust: a linked ~/.claude.json stays a link; the file it points to gets the change', async () => {
  const { lstatSync, symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'cm-trust-link-'));
  const real = join(dir, 'dotfiles-claude.json');
  writeFileSync(real, '{}');
  const link = join(dir, 'claude.json');
  symlinkSync(real, link);
  trustFolder('/Users/x/Dev/app', link);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(isTrusted('/Users/x/Dev/app', real), true);
});
