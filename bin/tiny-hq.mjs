#!/usr/bin/env node
// Tiny HQ's front door: `npx tiny-hq-office` (or `npx tiny-hq-office install`) copies the office into
// ~/.tiny-hq/app, puts a `tiny-hq` command in ~/.local/bin, and runs the setup wizard. Every other
// command (`tiny-hq open`, `doctor`, `uninstall`…) is handed to the installed copy.
//
// Why copy: the office is TypeScript run directly by Node (no build step), and Node won't strip
// types from files inside node_modules, where npx keeps packages. Plain JavaScript only in this file.

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq'));
const APP = join(HOME, 'app');
const FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
// What the office needs at run time, found wherever the package manager put it.
const RUNTIME = ['pixi.js', '@xterm/xterm', '@xterm/addon-fit', 'node-pty'];
// The package's own files that make up the office (package.json "files" ships the same).
const PARTS = ['src', 'web', 'hooks', 'manager', 'agents', 'skills', 'bin', 'package.json', 'LICENSE', 'README.md'];

const fail = (msg) => {
  console.error(`tiny-hq: ${msg}`);
  process.exit(1);
};

function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 17)) fail(`Node ${process.versions.node} is too old: Tiny HQ needs Node 22.17 or newer (https://nodejs.org).`);
  if (process.platform !== 'darwin') fail('Tiny HQ runs on macOS for now.');
}

const version = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
};

function copyApp() {
  if (HERE === APP) return; // running the installed copy already
  const has = (b) => spawnSync('/bin/sh', ['-c', `command -v ${b}`], { stdio: 'ignore' }).status === 0;
  if (!has('claude')) fail('Claude Code (`claude`) isn\'t on your PATH. Install it first: https://claude.com/claude-code');
  const from = version(HERE);
  const was = version(APP);
  console.log(was ? `Updating Tiny HQ ${was} -> ${from} in ${APP}` : `Installing Tiny HQ ${from} into ${APP}`);
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  chmodSync(HOME, 0o700);
  // Build the new copy next to the old one, then swap, so a failed copy never leaves half an office.
  const next = `${APP}.new`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  for (const part of PARTS) if (existsSync(join(HERE, part))) cpSync(join(HERE, part), join(next, part), { recursive: true, dereference: true });
  // Generated per Mac, kept across updates.
  for (const keep of ['manager/.claude/settings.local.json', 'manager/office.md']) {
    if (existsSync(join(APP, keep))) cpSync(join(APP, keep), join(next, keep));
  }
  for (const dep of RUNTIME) {
    const pkg = findDep(dep);
    if (!pkg) fail(`couldn't find ${dep}; try again with: npx tiny-hq-office@latest`);
    cpSync(pkg, join(next, 'node_modules', dep), { recursive: true, dereference: true });
  }
  rmSync(`${APP}.old`, { recursive: true, force: true });
  if (existsSync(APP)) renameSync(APP, `${APP}.old`);
  renameSync(next, APP);
  rmSync(`${APP}.old`, { recursive: true, force: true });
  for (const f of ['ask', 'delegate', 'desk', 'job', 'profiles', 'schedule']) chmodSync(join(APP, 'manager', f), 0o755);
  chmodSync(join(APP, 'hooks', 'office-name.sh'), 0o755);
  chmodSync(join(APP, 'bin', 'tiny-hq.mjs'), 0o755);
  linkCommand();
}

// A dependency's folder, the way Node looks for it: node_modules/<dep> here or in a folder above
// (npx puts the dependencies next to this package, not inside it).
function findDep(dep) {
  for (let dir = HERE; ; dir = dirname(dir)) {
    const pkg = join(dir, 'node_modules', dep);
    if (existsSync(join(pkg, 'package.json'))) return pkg;
    if (dirname(dir) === dir) return undefined;
  }
}

// `tiny-hq` on the PATH: a link in ~/.local/bin (Claude Code's own installer uses the same folder).
function linkCommand() {
  const dir = join(homedir(), '.local', 'bin');
  const link = join(dir, 'tiny-hq');
  const target = join(APP, 'bin', 'tiny-hq.mjs');
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() && readlinkSync(link) === target) return;
    return console.log(`(${link} already exists and isn't ours; left it alone. Run Tiny HQ with: node ${target})`);
  } catch {
    // not there yet
  }
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, link);
  const onPath = (process.env.PATH ?? '').split(':').includes(dir);
  console.log(`Added the \`tiny-hq\` command (${link})${onPath ? '' : `; add ${dir} to your PATH to use it`}.`);
}

const hand = (args) => {
  const r = spawnSync(process.execPath, [...FLAGS, join(APP, 'src', 'cli', 'tiny-hq.ts'), ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
};

checkNode();
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'install' || cmd === 'update') {
  copyApp();
  hand(cmd === 'update' && existsSync(join(HOME, 'config.json')) ? ['doctor'] : ['setup', ...rest]);
}
if (!existsSync(join(APP, 'src', 'cli', 'tiny-hq.ts'))) fail('Tiny HQ isn\'t installed yet. Run: npx tiny-hq-office');
hand([cmd, ...rest]);
