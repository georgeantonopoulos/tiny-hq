// The `tiny-hq` command, once installed (bin/tiny-hq.mjs copies the office to ~/.tiny-hq/app and
// hands over to this file):
//   tiny-hq setup       the five questions, then a yes or no for each thing added outside ~/.tiny-hq
//   tiny-hq open        start the office if needed and open it in the browser
//   tiny-hq start|stop  the office in the background (or its login item, if you chose one)
//   tiny-hq pair        a one-time link for a phone on your Tailscale (only if you set phone access up)
//   tiny-hq doctor      checks the set-up and says what's missing
//   tiny-hq uninstall   takes out the hooks, the skill link and the login items (--all also deletes ~/.tiny-hq)

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CONFIG_PATH, DATA_DIR, DEFAULT_PORT, MANAGER_DIR, NODE_FLAGS, REPO_ROOT } from '../paths.ts';
import { DEFAULT_CONFIG, STYLES, cleanName, loadConfig, saveConfig, type Config, type ManagerStyle } from '../config.ts';
import { LABEL, OPEN_LABEL, openPlist, plist } from '../daemon/launchd.ts';
import { HOOKS, MARK, installedHooks, linkSkill, loadAgent, loadInstalled, readSettings, saveInstalled, skillLink, unlinkSkill, unloadAgent, withHooks, withoutHooks, writeSettings, type HookSpec } from './install.ts';

const run = (file: string, args: string[] = []) => spawnSync(process.execPath, [...NODE_FLAGS, join(REPO_ROOT, 'src', 'cli', file), ...args], { stdio: 'inherit' }).status ?? 1;
const has = (bin: string) => spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const untilde = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

async function up(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`)).ok;
  } catch {
    return false;
  }
}

// ---- setup: the wizard ----
async function setup(args: string[]): Promise<number> {
  const defaults = args.includes('--defaults'); // every answer its default, nothing added outside ~/.tiny-hq
  // Answers are read as a queue of lines, so piped answers (scripts, tests) are never dropped; at the
  // end of input every remaining question takes its default.
  const rl = defaults ? undefined : createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines: string[] = [];
  const waiting: ((l: string | undefined) => void)[] = [];
  let ended = false;
  rl?.on('line', (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
  rl?.on('close', () => {
    ended = true;
    while (waiting.length) waiting.shift()!(undefined);
  });
  const nextLine = (): Promise<string | undefined> => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(undefined) : new Promise((r) => waiting.push(r)));
  const ask = async (q: string, def: string): Promise<string> => {
    if (!rl) return def;
    // In a terminal, readline owns the line (it echoes typing and redraws edits under its own prompt).
    if (process.stdin.isTTY) {
      rl.setPrompt(`${q} [${def}]: `);
      rl.prompt();
    } else process.stdout.write(`${q} [${def}]: `);
    const a = ((await nextLine()) ?? '').trim();
    if (!process.stdin.isTTY) process.stdout.write(`${a}\n`);
    return a || def;
  };
  const yes = async (q: string, def: boolean): Promise<boolean> => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));
  const before = existsSync(CONFIG_PATH) ? loadConfig(CONFIG_PATH) : { ...DEFAULT_CONFIG };

  console.log('\nTiny HQ setup. Press Enter to keep the answer in [brackets]; run `tiny-hq setup` again any time.\n');
  // First time: suggest the Mac account's full name.
  const macName = existsSync(CONFIG_PATH) ? '' : (spawnSync('id', ['-F'], { encoding: 'utf8' }).stdout ?? '').trim().split(' ')[0] ?? '';
  const nameDefault = cleanName(macName, before.ownerName);
  const ownerName = cleanName(await ask('1. Your name (what your manager calls you)', nameDefault), nameDefault);

  const found = before.projectRoots.filter((p) => existsSync(p));
  const roots = (await ask('2. Your project folders, comma-separated', (found.length ? found : before.projectRoots).map(tilde).join(', ')))
    .split(',')
    .map((p) => untilde(p.trim()))
    .filter((p) => p.startsWith('/'));
  const missing = roots.filter((p) => !existsSync(p));
  if (missing.length) console.log(`   (not there yet, kept anyway: ${missing.map(tilde).join(', ')})`);

  const managerName = cleanName(await ask("3. Your manager's name", before.managerName), before.managerName);
  const styleIn = await ask(`   Their style: ${STYLES.map((s, i) => `${i + 1} ${s}`).join(', ')}`, String(STYLES.indexOf(before.managerStyle) + 1));
  const managerStyle: ManagerStyle = STYLES[Number(styleIn) - 1] ?? (STYLES.includes(styleIn as ManagerStyle) ? (styleIn as ManagerStyle) : before.managerStyle);

  console.log('4. Extras (each can be switched on or off later):');
  const ghOk = has('gh');
  const github = await yes(`   GitHub keeper: watches your repos for other people's pull requests, issues and comments (uses your gh sign-in${ghOk ? '' : '; gh is not installed yet'})`, before.extras.github);
  const coffee = await yes('   Coffee room: a few times a day, 2-3 rooms share what they learned (one small Sonnet call each)', before.extras.coffee);
  const happenings = await yes('   Office happenings: little gags around the office, written by Haiku about once a day', before.extras.happenings);
  const phone = await yes('   Phone access over Tailscale (you set it up yourself; I print the steps)', !!before.remote);

  const login = await yes('5. Start the office when you log in?', loadInstalled(DATA_DIR)?.loginItems ?? !defaults);

  // Read Claude Code's settings first: a broken file stops setup before anything is saved.
  let settings: ReturnType<typeof readSettings>;
  try {
    settings = readSettings();
  } catch (err) {
    rl?.close();
    console.error(`\nCouldn't read ~/.claude/settings.json: ${err instanceof Error ? err.message : String(err)}\nFix that file (it must be valid JSON), then run \`tiny-hq setup\` again. Nothing was changed.`);
    return 1;
  }
  const config: Config = { ...before, ownerName, projectRoots: roots.length ? roots : before.projectRoots, managerName, managerStyle, extras: { github, coffee, happenings } };
  saveConfig(CONFIG_PATH, config);
  // The office's commands run from Claude Code sessions whose PATH may not have this Node (nvm, a GUI launch).
  writeFileSync(join(DATA_DIR, 'node'), process.execPath + '\n', { mode: 0o600 });
  console.log(`\nSaved your settings in ${tilde(CONFIG_PATH)}.`);

  // ---- consent: one yes or no for each thing added outside ~/.tiny-hq ----
  console.log('\nTiny HQ can add these to Claude Code. Each is optional, and `tiny-hq uninstall` takes them all out again.');
  const had = installedHooks(settings);
  const chosen: HookSpec['id'][] = [];
  for (const h of HOOKS) {
    console.log(`\n - ${h.what}`);
    if (await yes('   Add it?', !defaults && (had.length === 0 || had.some((c) => c.endsWith(`${MARK} ${h.id}`))))) chosen.push(h.id);
  }
  console.log(`\n - The theoffice skill: tells each room's Claude how the office works (a link in ${tilde(skillLink())}).`);
  const skill = await yes('   Add it?', !defaults);
  rl?.close();

  // --defaults never touches anything outside ~/.tiny-hq: what was added before stays as it was.
  if (defaults) {
    console.log('\n(--defaults: Claude Code settings, the skill and login items left as they were.)');
    return 0;
  }
  writeSettings(withHooks(settings, REPO_ROOT, chosen));
  let skillOn = false;
  if (skill) {
    const r = linkSkill(REPO_ROOT);
    skillOn = r !== 'taken';
    if (r === 'taken') console.log(`   ${tilde(skillLink())} is already something of yours; left it alone.`);
  } else unlinkSkill(REPO_ROOT);
  for (const dir of ['hooks', 'manager']) for (const f of readdirSync(join(REPO_ROOT, dir))) if (statSync(join(REPO_ROOT, dir, f)).isFile() && !f.includes('.')) chmodSync(join(REPO_ROOT, dir, f), 0o755);
  chmodSync(join(REPO_ROOT, 'hooks', 'office-name.sh'), 0o755);

  if (login) {
    loadAgent(LABEL, plist(process.execPath));
    loadAgent(OPEN_LABEL, openPlist(process.execPath));
  } else {
    unloadAgent(LABEL);
    unloadAgent(OPEN_LABEL);
  }
  saveInstalled(DATA_DIR, { hooks: chosen, skill: skillOn, loginItems: login, at: new Date().toISOString() });

  console.log(`\nDone. Hooks: ${chosen.length ? chosen.join(', ') : 'none'}. Skill: ${skillOn ? 'yes' : 'no'}. Start at login: ${login ? 'yes' : 'no'}.`);
  if (github && !ghOk) console.log('GitHub keeper: install the GitHub CLI and run `gh auth login`; it starts by itself after that.');
  if (phone) console.log(PHONE_STEPS);
  if (!defaults && !args.includes('--no-open')) return open([]);
  return 0;
}

const PHONE_STEPS = `
Phone access (optional, over your own Tailscale network only):
  1. Install Tailscale on this Mac and your phone, signed in to the same account.
  2. In ${tilde(CONFIG_PATH)} add: "remote": {"host": "<this-mac>.<tailnet>.ts.net", "login": "<your Tailscale login>"}
  3. Run: tailscale serve --bg --https=443 http://127.0.0.1:${DEFAULT_PORT + 1}
  4. Restart the office (tiny-hq stop, then tiny-hq open) and run \`tiny-hq pair\` for a one-time link to open on the phone.`;

// ---- open, start, stop ----
function open(args: string[]): number {
  return run('office.ts', args);
}

async function start(): Promise<number> {
  if (await up()) {
    console.log('The office is already running.');
    return 0;
  }
  if (loadInstalled(DATA_DIR)?.loginItems) {
    loadAgent(LABEL, plist(process.execPath));
    console.log('Started (login item).');
    return 0;
  }
  return open(['--no-browser']);
}

async function stop(): Promise<number> {
  const viaLaunchd = loadInstalled(DATA_DIR)?.loginItems;
  if (viaLaunchd) {
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`], { stdio: 'ignore' });
    } catch {
      // not loaded
    }
  }
  // Only the office itself: whatever listens on the port must be this office's daemon.
  try {
    const daemon = join(REPO_ROOT, 'src', 'daemon', 'main.ts');
    const pids = execFileSync('lsof', ['-t', '-iTCP:' + DEFAULT_PORT, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const pid of pids) {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
      const cwd = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pid], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
      if (cmd.includes(daemon) || (cmd.includes('src/daemon/main.ts') && cwd === REPO_ROOT)) process.kill(Number(pid), 'SIGTERM');
      else console.log(`Port ${DEFAULT_PORT} is used by something else (pid ${pid}); left it alone.`);
    }
  } catch {
    // nothing listening
  }
  console.log(viaLaunchd ? 'Stopped. It starts again at your next login (or `tiny-hq start`).' : 'Stopped. Your Claude sessions keep running.');
  return 0;
}

// ---- doctor ----
async function doctor(): Promise<number> {
  const rows: [boolean, string, string?][] = [];
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  rows.push([maj > 22 || (maj === 22 && min >= 17), `Node ${process.versions.node}`, 'Tiny HQ needs Node 22.17 or newer']);
  rows.push([has('claude'), 'Claude Code (claude) is installed', 'install Claude Code: https://claude.com/claude-code']);
  const c = loadConfig(CONFIG_PATH);
  rows.push([existsSync(CONFIG_PATH), `settings in ${tilde(CONFIG_PATH)}`, 'run `tiny-hq setup`']);
  rows.push([c.projectRoots.some((p) => existsSync(p)) || c.extraProjects.length > 0, `project folders: ${c.projectRoots.map(tilde).join(', ')}`, 'none of them exists: run `tiny-hq setup`']);
  if (c.extras.github) rows.push([has('gh'), 'GitHub CLI (gh) for the GitHub keeper', 'install gh and run `gh auth login`, or switch the keeper off in setup']);
  try {
    rows.push([(statSync(DATA_DIR).mode & 0o077) === 0, `${tilde(DATA_DIR)} is private to you`, `run: chmod 700 ${DATA_DIR}`]);
  } catch {
    rows.push([false, `${tilde(DATA_DIR)} exists`, 'run `tiny-hq setup`']);
  }
  const inst = loadInstalled(DATA_DIR);
  const hooks = (() => {
    try {
      return installedHooks(readSettings());
    } catch {
      return [];
    }
  })();
  for (const id of inst?.hooks ?? []) rows.push([hooks.some((h) => h.endsWith(`${MARK} ${id}`)), `hook: ${id}`, 'run `tiny-hq setup` to put it back']);
  if (inst?.skill) rows.push([existsSync(join(skillLink(), 'SKILL.md')), 'theoffice skill', 'run `tiny-hq setup` to link it again']);
  rows.push([existsSync(join(MANAGER_DIR, 'CLAUDE.md')) || !(await up()), "the manager's instructions", 'restart the office: `tiny-hq stop`, then `tiny-hq open`']);
  // Claude Code must be signed in, or no room (and no manager) can start.
  const signedIn = (() => {
    try {
      return (JSON.parse(spawnSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 }).stdout) as { loggedIn?: unknown }).loggedIn === true;
    } catch {
      return false;
    }
  })();
  rows.push([signedIn, 'Claude Code is signed in', 'run `claude` once in a terminal and sign in (/login); the office needs it to start sessions']);
  // Running means this office answers with its own token, not just anything on the port.
  const ours = await (async () => {
    try {
      const token = readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
      return (await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/floor`, { headers: { authorization: `Bearer ${token}` } })).ok;
    } catch {
      return false;
    }
  })();
  rows.push([ours, `the office is running on http://127.0.0.1:${DEFAULT_PORT}`, (await up()) && !ours ? `something else is using port ${DEFAULT_PORT}: stop it, or set CM_PORT to another port` : '`tiny-hq open` starts it; the log is ~/Library/Logs/tiny-hq.log']);
  for (const [ok, what, fix] of rows) console.log(`${ok ? 'ok  ' : 'FIX '} ${what}${ok || !fix ? '' : `\n      ${fix}`}`);
  return rows.every(([ok]) => ok) ? 0 : 1;
}

// ---- uninstall ----
async function uninstall(args: string[]): Promise<number> {
  await stop();
  unloadAgent(LABEL);
  unloadAgent(OPEN_LABEL);
  try {
    const s = readSettings();
    if (installedHooks(s).length) writeSettings(withoutHooks(s));
  } catch (err) {
    console.error(`Couldn't read ~/.claude/settings.json (${String(err)}); remove the lines containing "${MARK}" by hand.`);
  }
  unlinkSkill(REPO_ROOT);
  // The `tiny-hq` command, if it's our link.
  const cmd = join(homedir(), '.local', 'bin', 'tiny-hq');
  try {
    if (lstatSync(cmd).isSymbolicLink() && readlinkSync(cmd) === join(REPO_ROOT, 'bin', 'tiny-hq.mjs')) unlinkSync(cmd);
  } catch {
    // not there
  }
  console.log('Removed the hooks, the theoffice skill link, the login items and the `tiny-hq` command. Your Claude sessions and projects are untouched.');
  if (args.includes('--all')) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`Deleted ${tilde(DATA_DIR)} (settings, notebook, jobs, desk, and the office itself).`);
  } else console.log(`Your settings and the office's notes are still in ${tilde(DATA_DIR)}; \`tiny-hq uninstall --all\` deletes them too.`);
  return 0;
}

const HELP = `Tiny HQ: a little office for your Claude Code projects.

  tiny-hq setup        answer five questions; choose what gets added to Claude Code
  tiny-hq open         start the office if needed and open it in your browser
  tiny-hq start | stop run or stop the office in the background
  tiny-hq pair         a one-time link for your phone (after phone access is set up)
  tiny-hq doctor       check the set-up and say what's missing
  tiny-hq uninstall    take out the hooks, skill link and login items (--all: delete ~/.tiny-hq too)
  tiny-hq daemon       run the office in this terminal (for debugging)`;

const [cmd = 'help', ...rest] = process.argv.slice(2);
const code = await (async (): Promise<number> => {
  switch (cmd) {
    case 'setup':
      return setup(rest);
    case 'open':
      return open(rest);
    case 'pair':
      return open(['pair']);
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'doctor':
      return doctor();
    case 'uninstall':
      return uninstall(rest);
    case 'daemon':
      return new Promise<number>((res) => spawn(process.execPath, [...NODE_FLAGS, join(REPO_ROOT, 'src', 'daemon', 'main.ts')], { stdio: 'inherit' }).on('exit', (c) => res(c ?? 0)));
    default:
      console.log(HELP);
      return cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
})();
process.exitCode = code;
