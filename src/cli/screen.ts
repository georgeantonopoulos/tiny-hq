// manager/screen: a room turns the screen helper on for a test, off after. See src/team/screen.ts.
//   screen on [--minutes N] [--by "<your name>"]   |   screen off   |   screen status
import { DATA_DIR } from '../paths.ts';
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
  if (macLocked()) console.log('The Mac is locked, so captures fail or come back black. Only the owner can unlock it: put that on a --why hands button ("unlock the Mac, then press Done") and wait.');
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
