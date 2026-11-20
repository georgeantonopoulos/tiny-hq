// A still frame of the file a post carries, for its button: a button that only names the file lets
// the wrong video be approved by name. manager/ask --media makes it when the button goes up; the
// office shows it on the button so the owner sees which picture or video they are approving. Kept in
// ~/.tiny-hq/manager/stills/<sha256>.jpg, by the bytes they approve, so a still can never belong to a
// different file than the one the pass lets up.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const STILL_WIDTH = 640;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|gif)$/i;
const SHA = /^[0-9a-f]{64}$/;

export const stillsDir = (dataDir: string) => join(dataDir, 'manager', 'stills');
export const stillFile = (dataDir: string, sha256: string): string | undefined => (SHA.test(sha256) ? join(stillsDir(dataDir), `${sha256}.jpg`) : undefined);

// The still for these bytes, if it was made.
export function stillOf(dataDir: string, sha256: string | undefined): string | undefined {
  const f = sha256 ? stillFile(dataDir, sha256) : undefined;
  try {
    return f && statSync(f).isFile() ? f : undefined;
  } catch {
    return undefined;
  }
}

// Make the still of `src` (an image, or a video's frame one second in, else its first frame).
// Returns its path, or undefined when no still could be made (the button still goes up, naming the file).
export function makeStill(src: string, sha256: string, dataDir: string, run = spawnSync): string | undefined {
  const out = stillFile(dataDir, sha256);
  if (!out) return undefined;
  if (stillOf(dataDir, sha256)) return out;
  mkdirSync(stillsDir(dataDir), { recursive: true, mode: 0o700 });
  const ok = () => existsSync(out) && statSync(out).size > 0;
  const opts = { timeout: 30_000, stdio: 'ignore' as const };
  if (IMAGE.test(src) && !/\.gif$/i.test(src)) {
    run('sips', ['-s', 'format', 'jpeg', '-Z', String(STILL_WIDTH), src, '--out', out], opts);
    if (ok()) return out;
  }
  if (VIDEO.test(src) || IMAGE.test(src)) {
    // A file input only (never a camera: no -f avfoundation). -nostdin so it can't wait on a terminal.
    for (const at of ['1', '0']) {
      run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-ss', at, '-i', src, '-frames:v', '1', '-vf', `scale='min(${STILL_WIDTH},iw)':-2`, out], opts);
      if (ok()) return out;
    }
  }
  // Anything else (a PDF, a document): Quick Look's thumbnail.
  const tmp = join(stillsDir(dataDir), `${sha256}.ql`);
  mkdirSync(tmp, { recursive: true });
  run('qlmanage', ['-t', '-s', String(STILL_WIDTH), '-o', tmp, src], { ...opts, timeout: 10_000 });
  const png = join(tmp, `${src.split('/').pop()}.png`);
  if (existsSync(png)) run('sips', ['-s', 'format', 'jpeg', png, '--out', out], opts);
  rmSync(tmp, { recursive: true, force: true });
  if (ok()) return out;
  rmSync(out, { force: true });
  return undefined;
}
