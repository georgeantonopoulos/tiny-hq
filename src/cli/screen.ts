// manager/screen: a room turns the screen helper on for a test, off after. See src/team/screen.ts.
//   screen on [--minutes N] [--by "<your name>"]   |   screen off   |   screen status
import { spawn, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { DATA_DIR, REPO_ROOT } from '../paths.ts';
import { clearMarker, DEFAULT_MINUTES, helperInstalled, helperRunning, keepAwake, letSleep, macLocked, markerPath, readMarker, startHelper, stopHelper, writeMarker } from '../team/screen.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const path = markerPath(DATA_DIR);
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

if (cmd === 'on') {
  if (!helperInstalled()) {
    console.log("The screen helper isn't set up on this Mac (the owner turns it on once with `tiny-hq screen setup`). Tell the manager; don't ask the owner in chat.");
    process.exit(1);
  }
  const minutes = Number(flag('--minutes') ?? DEFAULT_MINUTES);
  letSleep(readMarker(path)?.awake);
  const on = writeMarker(path, flag('--by') ?? 'a room', minutes, Date.now(), keepAwake(minutes));
  startHelper();
  for (let i = 0; i < 20 && !helperRunning(); i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1500)); // let it open its socket
  console.log(helperRunning() ? `Screen helper on until ${clock(on.until)}, and the display stays awake till then. Use peekaboo now (image, see, click, type); run "screen off" when you're done.` : "The screen helper didn't start: tell the manager.");
  if (macLocked()) askToUnlock(flag('--by') ?? basename(process.cwd()));
} else if (cmd === 'off') {
  stopHelper();
  letSleep(readMarker(path)?.awake);
  clearMarker(path);
  console.log('Screen helper off.');
} else if (cmd === 'status' || !cmd) {
  const m = readMarker(path);
  console.log(helperRunning() ? `On${m ? ` until ${clock(m.until)}, turned on by ${m.by}` : ' (nobody turned it on: the office will stop it)'}.` : helperInstalled() ? 'Off.' : 'Not set up (`tiny-hq screen setup`).');
  if (macLocked()) console.log('The Mac is locked: captures fail until the owner unlocks it.');
} else {
  console.error('usage: screen on [--minutes N] [--by "<your name>"] | screen off | screen status');
  process.exit(1);
}

// A locked Mac can't be captured, and only the owner can unlock it. The office wakes the display and
// puts the question over the room's head itself, so a room never fails quietly on a locked Mac.
function askToUnlock(who: string): void {
  try {
    spawn('/usr/bin/caffeinate', ['-u', '-t', '5'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // the button still goes up
  }
  const mac = tailnetName() ?? hostname().replace(/\.(local|home)$/, '');
  const r = spawnSync(
    join(REPO_ROOT, 'manager', 'ask'),
    [
      `Your Mac is locked and ${who} needs the screen. Unlock it (at the Mac, or from your phone's Screen Sharing app: connect to ${mac}), then press Done.`.slice(0, 200),
      '--why',
      'hands',
      '--tried',
      `The screen helper is on, but macOS refuses screenshots while the Mac is locked, and only you can unlock it. The office woke the display. Away? Press Stuck and ${who} waits until you're back.`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  console.log(
    r.status === 0
      ? "The Mac is locked, so captures fail until the owner unlocks it. A button asking them to unlock it is now over your head: wait for their Done, then check `manager/screen status` before you capture."
      : `The Mac is locked, so captures fail until the owner unlocks it, and the unlock button couldn't be put up (${(r.stderr || r.stdout).trim().slice(0, 200)}): tell the manager.`,
  );
}

// The Mac's name on the owner's Tailscale network (what their phone connects to), if they use Tailscale.
function tailnetName(): string | undefined {
  for (const bin of ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const r = spawnSync(bin, ['status', '--self', '--json'], { encoding: 'utf8', timeout: 5000 });
      const name = (JSON.parse(r.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.split('.')[0];
      if (name) return name;
    } catch {
      // not this one
    }
  }
  return undefined;
}
