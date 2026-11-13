// Handy tools the welcome page suggests: what each adds to the office, whether it's here, and how to
// get it. Installs run only from this fixed list (Homebrew, no password prompts); anything that needs
// the owner's password or a sign-in opens in Terminal or on its own website instead.

import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Tool {
  id: string;
  name: string;
  what: string; // what Tiny HQ does with it, in plain words
  url: string; // where to get it by hand
  brew?: string[][]; // the commands that install it, each starting with "brew"
  signIn?: string; // a Terminal command that signs in, once it's installed
  open?: string; // an app to open once (a menu bar app starts itself after that)
}

export const TOOLS: Tool[] = [
  {
    id: 'gh',
    name: 'GitHub CLI',
    what: "Lets the GitHub keeper see other people's pull requests, issues and comments on your projects.",
    url: 'https://cli.github.com',
    brew: [['brew', 'install', 'gh']],
    signIn: 'gh auth login',
  },
  {
    id: 'codexbar',
    name: 'CodexBar',
    what: 'Shows how much of your Claude and Codex allowance is left, at the top of the office, and lets rooms work on their goals when there is room to spare.',
    url: 'https://codexbar.app',
    brew: [['brew', 'install', '--cask', 'codexbar']],
    open: 'CodexBar',
  },
  {
    id: 'codex',
    name: 'Codex',
    what: "OpenAI's coding agent. The office finds your Codex projects too and shows its usage next to Claude's.",
    url: 'https://developers.openai.com/codex/cli',
    brew: [['brew', 'install', '--cask', 'codex']],
    signIn: 'codex login',
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    what: 'A notes app on your Mac, for keeping project notes as plain files you and your rooms can read.',
    url: 'https://obsidian.md',
    brew: [['brew', 'install', '--cask', 'obsidian']],
  },
  {
    // Pinned to one reviewed commit: a click installs exactly that, never whatever the repo holds later.
    id: 'obmem',
    name: 'Project memory (Obsidian memory bank)',
    what: 'Rooms write down decisions, fixes and open questions in an Obsidian vault, so the next session remembers them. Its guide shows how to connect it to Claude Code.',
    url: 'https://github.com/georgeantonopoulos/obsidian-cli-memory-bank-skill#install',
    brew: [['brew', 'install', 'pipx'], ['pipx', 'install', 'git+https://github.com/georgeantonopoulos/obsidian-cli-memory-bank-skill.git@ebd9e4e15a79586de6772428afd105d81ccf5a75']],
  },
  {
    id: 'tailscale',
    name: 'Tailscale',
    what: 'Opens your office on your phone, privately, over your own network. It installs from its website (it asks for your Mac password).',
    url: 'https://tailscale.com/download/mac',
  },
];

const BREW = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
export const brewPath = (): string | undefined => BREW.find((b) => existsSync(b));
const onPath = (bin: string) => spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
const anyOf = (...paths: string[]) => paths.some((p) => existsSync(p));

// The usage app's command-line reader, if it's here (the usage bar and goal pacing read it).
export function usageMeterBin(): string | undefined {
  return ['/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI', '/opt/homebrew/bin/codexbar', '/usr/local/bin/codexbar'].find((p) => existsSync(p));
}

export function installed(id: string): boolean {
  switch (id) {
    case 'gh':
      return onPath('gh') || anyOf('/opt/homebrew/bin/gh', '/usr/local/bin/gh');
    case 'codexbar':
      return !!usageMeterBin() || existsSync('/Applications/CodexBar.app');
    case 'codex':
      return onPath('codex') || anyOf('/opt/homebrew/bin/codex', '/usr/local/bin/codex');
    case 'obsidian':
      return existsSync('/Applications/Obsidian.app');
    case 'obmem':
      return onPath('obmem') || existsSync(join(process.env.HOME ?? '', '.local', 'bin', 'obmem'));
    case 'tailscale':
      return existsSync('/Applications/Tailscale.app') || onPath('tailscale');
    default:
      return false;
  }
}

// Signed in, where that matters (undefined: no sign-in to check).
export function signedIn(id: string): boolean | undefined {
  if (id === 'gh' && installed('gh')) return spawnSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  return undefined;
}

export function toolStates(): { id: string; name: string; what: string; url: string; installed: boolean; signedIn?: boolean; canInstall: boolean; signIn: boolean }[] {
  const brew = !!brewPath();
  return TOOLS.map((t) => {
    const here = installed(t.id);
    const s = signedIn(t.id);
    return { id: t.id, name: t.name, what: t.what, url: t.url, installed: here, ...(s !== undefined ? { signedIn: s } : {}), canInstall: brew && !!t.brew, signIn: !!t.signIn };
  });
}

// Installs one tool from the list with Homebrew, never asking for a password (an install that would
// is reported, with its website). Resolves with an error message, or undefined when it worked.
export async function install(id: string): Promise<string | undefined> {
  const t = TOOLS.find((x) => x.id === id);
  const brew = brewPath();
  if (!t?.brew) return 'That one installs from its website.';
  if (!brew) return 'Homebrew is not installed; get the tool from its website instead.';
  for (const [cmd, ...args] of t.brew) {
    const bin = cmd === 'brew' ? brew : join(brew, '..', cmd!); // tools Homebrew installs land next to it
    const err: string | undefined = await new Promise<string | undefined>((resolve) =>
      execFile(bin, args, { timeout: 15 * 60_000, env: { ...process.env, NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1', SUDO_ASKPASS: '/usr/bin/false' }, maxBuffer: 20 * 1024 * 1024 }, (e, _o, stderr) =>
        resolve(e ? String(stderr || e.message).trim().split('\n').slice(-3).join(' ').slice(0, 300) : undefined),
      ),
    );
    if (err) return `${t.name} didn't install: ${err}`;
  }
  if (t.open) spawnSync('open', ['-a', t.open], { stdio: 'ignore' });
  return installed(id) ? undefined : `${t.name} installed, but the office can't find it yet. Try "Look again" in a minute.`;
}

// Opens Terminal with the tool's sign-in command (no permissions needed: a .command file opens in Terminal).
export function openSignIn(id: string): string | undefined {
  const t = TOOLS.find((x) => x.id === id);
  if (!t?.signIn) return 'Nothing to sign in to.';
  const dir = mkdtempSync(join(tmpdir(), 'tiny-hq-signin-'));
  const file = join(dir, `sign-in-${t.id}.command`);
  writeFileSync(file, `#!/bin/sh\nclear\necho "Signing in to ${t.name}. Follow the steps below, then close this window."\necho\n${t.signIn}\n`);
  chmodSync(file, 0o700);
  return spawnSync('open', ['-a', 'Terminal', file], { stdio: 'ignore' }).status === 0 ? undefined : "Couldn't open Terminal.";
}
