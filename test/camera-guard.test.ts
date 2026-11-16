import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain .mjs hook, no types
import { deviceUse, decideCamera } from '../hooks/camera-guard.mjs';
import { grantPass } from '../src/team/posts.ts';
import { REASONS } from '../src/team/only-owner.ts';

// A room photographing something on the desk would otherwise switch the camera on unannounced.
test('camera and microphone capture is spotted, wherever the command sits', () => {
  for (const c of [
    'ffmpeg -f avfoundation -i 0 -frames:v 1 lamp.jpg',
    '/opt/homebrew/bin/ffmpeg -y -f avfoundation -framerate 30 -i "0:none" -frames:v 1 x.jpg',
    'ffmpeg -f avfoundation -i ":0" -t 5 voice.wav',
    'cd /tmp && timeout 10 ffmpeg -f avfoundation -i 0 out.mp4',
    'bash -c "ffmpeg -f avfoundation -i 0 a.jpg"',
    'echo $(imagesnap -w 1 shot.jpg)',
    'imagesnap shot.jpg',
    'rec voice.wav trim 0 5',
    'sox -d voice.wav',
    'sox -t coreaudio "MacBook Pro Microphone" out.wav',
    'gst-launch-1.0 avfvideosrc ! fakesink',
    'open -a "Photo Booth"',
    'python3 -c "import cv2; cv2.VideoCapture(0).read()"',
    // stdin code, runners, script files, other ways to open Photo Booth
    "python3 - <<'EOF'\nimport cv2\ncv2.VideoCapture(0).read()\nEOF",
    "swift - <<'EOF'\nimport AVFoundation\nlet s = AVCaptureSession()\nEOF",
    "uv run --with opencv-python python3 -c 'import cv2; cv2.VideoCapture(0).read()'",
    "xcrun swift -e 'let s = AVCaptureSession()'",
    'npx -y ffmpeg -f avfoundation -i 0 a.jpg',
    'python3 -c "import sounddevice as sd; sd.rec(44100)"',
    'sox -V -d out.wav',
    'open /System/Applications/Photo\\ Booth.app',
    'open -b com.apple.PhotoBooth',
    `osascript -e 'tell application "Photo Booth" to activate'`,
  ])
    assert.ok(deviceUse(c), c);
  for (const c of [
    'ffmpeg -f avfoundation -list_devices true -i ""',
    'ffmpeg -i in.mov -frames:v 1 out.jpg',
    'ffmpeg -h',
    'imagesnap -l',
    'sox in.wav out.mp3',
    'sox in.wav -d',
    'sox -n out.wav synth 1 sine 440',
    'open -a Safari',
    'git commit -m "guard ffmpeg -f avfoundation -i 0"',
    "cat <<'EOF'\nffmpeg -f avfoundation -i 0\nEOF",
    'grep -rn AVCaptureSession src',
    'ls',
    'python3 -m pip install pyaudio sounddevice',
    'python3 -c "import sounddevice as sd; print(sd.query_devices())"',
    `node -e "require('fs').readFileSync('src/getUserMedia.ts')"`,
    'swift test --filter AVCaptureSessionTests',
    'ffmpeg -i in.mov -f avfoundation out',
    'uv run pytest',
  ])
    assert.equal(deviceUse(c), undefined, c);
});

test('a script file the interpreter runs is read for capture code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cam-'));
  writeFileSync(join(dir, 'snap.py'), 'import cv2\ncam = cv2.VideoCapture(0)\n');
  writeFileSync(join(dir, 'plain.py'), 'print(1)\n');
  assert.ok(deviceUse('python3 snap.py', dir));
  assert.ok(deviceUse('uv run python snap.py', dir));
  assert.equal(deviceUse('python3 plain.py', dir), undefined);
});

test('a capture waits for the owner: refused without a pass; their Approve lets it run once, from that room only', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cam-')), 'post-approvals.json');
  const cmd = { command: 'ffmpeg -f avfoundation -i 0 -frames:v 1 lamp.jpg' };
  const room = '/Users/x/Dev/desk-lamp';
  const now = Date.now();
  assert.match(decideCamera('Bash', cmd, { cwd: room, session_id: 's' }, now, path), /--why camera/);
  // A yes for one capture can't be spent on another: the pass holds the exact command.
  grantPass(path, 'Photograph the lamp: imagesnap lamp.jpg', room, now, 'device:camera');
  assert.match(decideCamera('Bash', { command: 'rec private.wav' }, { cwd: room, session_id: 's' }, now, path), /microphone|camera/, 'a different capture');
  assert.match(decideCamera('Bash', cmd, { cwd: room, session_id: 's' }, now, path), /camera/, 'not the approved command');
  assert.equal(decideCamera('Bash', { command: 'imagesnap  lamp.jpg' }, { cwd: room, session_id: 's' }, now, path), undefined, 'the approved one, spaces aside');
  grantPass(path, 'Photograph the lamp: ffmpeg -f avfoundation -i 0 -frames:v 1 lamp.jpg', room, now, 'device:camera');
  assert.match(decideCamera('Bash', cmd, { cwd: '/Users/x/Dev/other', session_id: 's' }, now, path), /camera/, 'another room');
  assert.equal(decideCamera('Bash', cmd, { cwd: `${room}/.claude/worktrees/w`, session_id: 's' }, now, path), undefined, 'the room, from its worktree');
  assert.match(decideCamera('Bash', cmd, { cwd: room, session_id: 's' }, now, path), /camera/, 'used up');
  // A post's pass never opens the camera.
  grantPass(path, 'hello', room, now, 'o/r#1');
  assert.match(decideCamera('Bash', cmd, { cwd: room, session_id: 's' }, now, path), /camera/);
  // Other tools and harmless commands are left alone.
  assert.equal(decideCamera('Bash', { command: 'ls' }, { cwd: room }, now, path), undefined);
  assert.equal(decideCamera('Read', cmd, { cwd: room }, now, path), undefined);
});

test('the hook refuses a capture over stdin, and camera is a button reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cam-'));
  const out = execFileSync('node', ['hooks/camera-guard.mjs'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ffmpeg -f avfoundation -i 0 x.jpg' }, cwd: dir, session_id: 's' }), env: { ...process.env, CM_DATA_DIR: dir } }).toString();
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(execFileSync('node', ['hooks/camera-guard.mjs'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir }), env: { ...process.env, CM_DATA_DIR: dir } }).toString(), '');
  assert.ok('camera' in REASONS);
});
