// `tiny-hq open`: makes sure the daemon is running, then opens the office in
// the browser with a one-time sign-in code (never the token itself).

import { spawn, execFile } from 'node:child_process';
import { openSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_PATH, DEFAULT_PORT, NODE_FLAGS, REPO_ROOT, TOKEN_PATH } from '../paths.ts';
import { loadConfig } from '../config.ts';

const base = `http://127.0.0.1:${DEFAULT_PORT}`;

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`)).ok;
  } catch {
    return false;
  }
}

// At login (com.tiny-hq.open): launchd is starting the daemon too, so wait for it (up to
// three minutes, the Mac may still be waking its disks) rather than start a second one.
const atLogin = process.argv.includes('--at-login');
if (atLogin) {
  for (let i = 0; i < 360 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) {
    console.error("office: at login the daemon didn't come up within 3 minutes; open it later with tiny-hq open");
    process.exit(1);
  }
}

if (!(await up())) {
  const logFile = join(homedir(), 'Library', 'Logs', 'tiny-hq.log');
  const out = openSync(logFile, 'a');
  spawn(process.execPath, [...NODE_FLAGS, join(REPO_ROOT, 'src', 'daemon', 'main.ts')], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
  }).unref();
  process.stdout.write('Starting the office');
  for (let i = 0; i < 40 && !(await up()); i++) {
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write('\n');
  if (!(await up())) {
    console.error(`The daemon didn't start. See ${logFile}`);
    process.exit(1);
  }
}

if (process.argv.includes('--no-browser')) {
  console.log(`The office is running on ${base}. Open it with: tiny-hq open`);
  process.exit(0);
}

if (!existsSync(TOKEN_PATH)) {
  console.error(`No token at ${TOKEN_PATH}.`);
  process.exit(1);
}
const token = readFileSync(TOKEN_PATH, 'utf8').trim();
const pairing = process.argv[2] === 'pair';
const r = await fetch(`${base}/api/login-code${pairing ? '?for=pairing' : ''}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
if (!r.ok) {
  console.error(`Couldn't get a sign-in code (${r.status}).`);
  process.exit(1);
}
const { code } = (await r.json()) as { code: string };
if (pairing) {
  // A phone on the owner's Tailscale opens this once; it then gets its own key.
  const remote = loadConfig(CONFIG_PATH).remote;
  if (!remote) {
    console.error(`Phone access is off. Run \`tiny-hq setup\` and say yes to phone access for the steps.`);
    process.exit(1);
  }
  // https only: Tailscale serves the page with its own certificate.
  console.log(`Open this on the phone within 10 minutes (works once, only on your Tailscale):\nhttps://${remote.host}/#code=${code}`);
  process.exit(0);
}
execFile('open', [`${base}/#code=${code}`], (err) => {
  if (err) console.error(`Couldn't open the browser: ${err.message}`);
  else console.log('The office is open in your browser.');
});
