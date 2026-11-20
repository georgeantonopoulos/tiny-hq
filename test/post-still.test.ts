// A post button shows a still frame of the file it carries: a button that only names the file lets
// the wrong video be approved by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStill, stillOf } from '../src/team/stills.ts';
import { createDaemon } from '../src/daemon/server.ts';
import { loadAsks } from '../src/team/asks.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('a still is made of a picture and of a video, named by the bytes, and nothing for a file that has no picture', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
  const data = mkdtempSync(join(tmpdir(), 'still-'));
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const png = join(dir, 'site.png');
  const mp4 = join(dir, 'site.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240', '-frames:v', '1', png]);
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=2:s=320x240:r=10', '-pix_fmt', 'yuv420p', mp4]);
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.ok(makeStill(png, a, data));
  assert.ok(makeStill(mp4, b, data));
  for (const sha of [a, b]) assert.ok(statSync(stillOf(data, sha)!).size > 500, sha);
  assert.equal(makeStill(png, '../../etc/x', data), undefined); // only a SHA-256 names a still
  const txt = join(dir, 'notes.bin');
  writeFileSync(txt, Buffer.alloc(64));
  assert.equal(makeStill(txt, 'c'.repeat(64), data), undefined);
});

const call = (port: number, path: string) =>
  new Promise<{ status: number; type: string }>((ok, no) => {
    const r = request({ port, path, headers: { authorization: 'Bearer t' } }, (res) => {
      res.resume();
      res.on('end', () => ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '') }));
    });
    r.on('error', no);
    r.end();
  });

test('the office serves a still only for a file an open button carries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'still-'));
  const jpg = join(dir, 'x.jpg');
  writeFileSync(jpg, 'jpeg!');
  const sha = 'd'.repeat(64);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const d = createDaemon({ token: 't', port, floor: () => ({ rooms: [] }), askStill: (s) => (s === sha ? jpg : undefined) });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  try {
    const good = await call(port, `/api/ask-still?sha=${sha}`);
    assert.equal(good.status, 200);
    assert.equal(good.type, 'image/jpeg');
    assert.equal((await call(port, `/api/ask-still?sha=${'e'.repeat(64)}`)).status, 404);
    assert.notEqual((await call(port, '/api/ask-still?sha=../x')).status, 200);
  } finally {
    d.close();
  }
});

test('manager/ask --media makes the still the button shows', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'still-room-')));
  const room = join(top, 'Site');
  const data = join(top, 'data');
  mkdirSync(room, { recursive: true });
  mkdirSync(data);
  execFileSync('git', ['-C', room, 'init', '-q']);
  writeFileSync(join(data, 'floor.json'), JSON.stringify({ seated: [room], away: [] }));
  const mp4 = join(room, 'website.mp4');
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=2:s=320x240:r=10', '-pix_fmt', 'yuv420p', mp4]);
  const cli = new URL('../src/cli/ask.ts', import.meta.url).pathname;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', cli, 'Post the launch video on X?', '--why', 'post', '--tried', 'checked the video plays and the text fits', '--text', 'We launched.', '--target', 'https://x.com/compose/post', '--media', 'website.mp4'], { cwd: room, encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: data } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /still frame of website\.mp4/);
  const ask = loadAsks(join(data, 'manager', 'asks.json')).find((a) => a.media);
  assert.ok(ask?.media && stillOf(data, ask.media.sha256), 'still on disk for the button');
});

// Unwired is the failure: the office hands the still to the page, and the button draws it.
test('the still is wired from the open button to the page', () => {
  const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(src('src/daemon/main.ts'), /stillOf\(DATA_DIR, ask\.media\.sha256\) \? \{ still: ask\.media\.sha256 \}/);
  assert.match(src('src/daemon/main.ts'), /askStill: \(sha: string\) =>/);
  assert.match(src('web/app/main.ts'), /api\.askStill\(sha\)/);
  assert.match(src('web/app/bubbles.ts'), /post-still[\s\S]{0,200}loadStill\(ask\.still\)/);
});
