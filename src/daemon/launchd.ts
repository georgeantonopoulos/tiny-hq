// Writes the launchd plist that keeps the daemon running. It only WRITES the
// file into ./launchd; it never loads it. Loading is a separate, deliberate step:
//   cp launchd/com.tiny-hq.daemon.plist ~/Library/LaunchAgents/
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tiny-hq.daemon.plist
// Same for com.tiny-hq.open, which opens the office page once at login (otherwise the owner
// has to open it by hand after every restart, though the daemon itself comes back on its own).

import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { NODE_FLAGS, REPO_ROOT } from '../paths.ts';

export const LABEL = 'com.tiny-hq.daemon';
export const OPEN_LABEL = 'com.tiny-hq.open';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(nodePath: string, home = homedir()): string {
  return agent(LABEL, [nodePath, ...NODE_FLAGS, join(REPO_ROOT, 'src', 'daemon', 'main.ts')], true, nodePath, home);
}

// Opens the office in the browser once at login: no KeepAlive, so closing the tab is final.
// `--at-login` waits for the daemon launchd is starting instead of starting a second one.
export function openPlist(nodePath: string, home = homedir()): string {
  return agent(OPEN_LABEL, [nodePath, ...NODE_FLAGS, join(REPO_ROOT, 'src', 'cli', 'office.ts'), '--at-login'], false, nodePath, home);
}

function agent(label: string, args: string[], keepAlive: boolean, nodePath: string, home: string): string {
  // launchd starts with a bare PATH; add where claude, git and gh live (Homebrew included).
  const path = [dirname(nodePath), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const logFile = join(home, 'Library', 'Logs', 'tiny-hq.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${esc(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(path)}</string>${process.env.CM_DATA_DIR ? `\n    <key>CM_DATA_DIR</key><string>${esc(process.env.CM_DATA_DIR)}</string>` : ''}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive ? '<true/>' : '<false/>'}
  <!-- Interactive, not Background: the owner waits on this. Background priority made
       every claude it starts (and the terminals they type into) 10-20x slower. -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  for (const [label, text] of [[LABEL, plist(process.execPath)], [OPEN_LABEL, openPlist(process.execPath)]] as const) {
    const out = join(REPO_ROOT, 'launchd', `${label}.plist`);
    writeFileSync(out, text);
    console.log(`Wrote ${out} (not loaded).`);
  }
}
