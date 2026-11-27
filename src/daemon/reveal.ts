// A file or folder path the owner clicks in Tiny HQ opens Finder there, so a report naming a
// screenshot or a build folder is one click away.
// Finder only ever shows the place: a folder opens, anything else (a file, an app, a bundle) is
// selected in its folder with `open -R`, so a click never runs or opens what the path names.

import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';

// A path as written in a message (`~/x`, `/Users/...`, `file:///...`) to an absolute path, or undefined.
export function pathOf(written: string, home = homedir()): string | undefined {
  let p = written.trim();
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(p.slice('file://'.length));
    } catch {
      return undefined;
    }
  }
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  if (!p.startsWith('/') || p.includes('\0')) return undefined;
  return p.replace(/\/+$/, '') || '/';
}

// Where a click may take Finder: the owner's home, temporary files, and other disks.
const ALLOWED = (home: string) => [home, '/tmp', '/private/tmp', '/private/var/folders', '/var/folders', '/Volumes'];

// The `open` arguments for a written path, or undefined when it doesn't exist or is outside those places.
// A path that's gone falls back to its nearest folder that's still there, so the click still lands.
export function revealArgs(written: string, home = homedir()): string[] | undefined {
  let p = pathOf(written, home);
  if (!p) return undefined;
  let real: string | undefined;
  for (let tries = 0; p && p !== '/' && tries < 64; tries++) {
    try {
      real = realpathSync(p);
      break;
    } catch {
      p = p.slice(0, p.lastIndexOf('/')) || '/';
    }
  }
  if (!real) return undefined;
  const realHome = (() => {
    try {
      return realpathSync(home);
    } catch {
      return home;
    }
  })();
  if (!ALLOWED(realHome).some((root) => real === root || real!.startsWith(`${root}/`))) return undefined;
  let dir = false;
  try {
    dir = statSync(real).isDirectory();
  } catch {
    return undefined;
  }
  // A folder with an extension (Foo.app, a .bundle, a .photoslibrary) is a package Finder would launch: select it instead.
  return dir && !/\.[A-Za-z0-9]+$/.test(basename(real)) ? [real] : ['-R', real];
}

export function reveal(written: string): Promise<boolean> {
  const args = revealArgs(written);
  if (!args) return Promise.resolve(false);
  return new Promise((done) => execFile('/usr/bin/open', args, { timeout: 10_000 }, (err) => done(!err)));
}
