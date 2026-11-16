// manager/screen: a room turns the screen helper on for a test, off after. See src/team/screen.ts.
//   screen on [--minutes N] [--by "<your name>"]   |   screen off   |   screen status
//   screen click|type|press|hotkey|scroll|move|drag|... <peekaboo's arguments>   (waits for 30 s of stillness)
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from '../paths.ts';
import { clearMarker, DEFAULT_MINUTES, helperInstalled, helperRunning, idleMs, keepAwake, lastInputPath, letSleep, macLocked, markerPath, readLastInput, readMarker, startHelper, STILL_MS, stillEnough, stopHelper, writeLastInput, clearLastInput, ownEvent, writeMarker } from '../team/screen.ts';
// @ts-expect-error a plain-JS hook module, no type declarations
import { INPUT_VERBS, isInput } from '../../hooks/screen-click-guard.mjs';

// No button asking the owner to unlock the Mac: software can't unlock it for them, and making them
// fetch their phone, open an app and sign in just so a room can take a screenshot isn't worth it.
// A web page is tested in a hidden browser instead, which works while the Mac is locked; a desktop
// app waits quietly until the owner is next at the Mac.
const LOCKED_NOTE =
  "The Mac is locked, so screenshots and clicks fail until the owner is back at it. Don't ask them to unlock it. A web page: test it in a hidden (headless) browser instead, which works while the Mac is locked. A desktop app: run `manager/screen off`, note in your job that the test waits for the Mac to be unlocked, and try `manager/screen status` again later.";

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
  console.log(helperRunning() ? `Screen helper on until ${clock(on.until)}, and the display stays awake till then. Look with peekaboo (image, see) and click or type with "manager/screen click|type ..."; run "screen off" when you're done.` : "The screen helper didn't start: tell the manager.");
  if (macLocked()) console.log(LOCKED_NOTE);
} else if (cmd === 'off') {
  stopHelper();
  letSleep(readMarker(path)?.awake);
  clearMarker(path);
  console.log('Screen helper off.');
} else if (cmd === 'status' || !cmd) {
  const m = readMarker(path);
  console.log(helperRunning() ? `On${m ? ` until ${clock(m.until)}, turned on by ${m.by}` : ' (nobody turned it on: the office will stop it)'}.` : helperInstalled() ? 'Off.' : 'Not set up (`tiny-hq screen setup`).');
  if (macLocked()) console.log(LOCKED_NOTE);
} else if (INPUT_VERBS.includes(cmd)) {
  process.exit(await input(cmd!, rest));
} else {
  console.error(`usage: screen on [--minutes N] [--by "<your name>"] | screen off | screen status | screen <${INPUT_VERBS.join('|')}> <peekaboo's arguments>`);
  process.exit(1);
}

// Waits until the keyboard and mouse have been still for 30 s, then runs the peekaboo input
// command. Gives up after SCREEN_WAIT_S seconds (default 100, inside a Bash call's 2 minutes)
// without clicking anything.
async function input(verb: string, args: string[]): Promise<number> {
  if (!isInput(verb, args)) return spawnSync('peekaboo', [verb, ...args], { stdio: 'inherit' }).status ?? 1; // help or a list: nothing to wait for
  const lastPath = lastInputPath(DATA_DIR);
  const asked = Number(process.env.SCREEN_WAIT_S);
  const give = (process.env.SCREEN_WAIT_S && Number.isFinite(asked) && asked >= 0 ? asked : 100) * 1000;
  const start = Date.now();
  let told = false;
  for (;;) {
    const idle = idleMs();
    const now = Date.now();
    if (idle === undefined) {
      console.log(`Couldn't read how long the Mac has been idle, so nothing was ${verb === 'type' ? 'typed' : 'clicked'}: tell the manager.`);
      return 4;
    }
    if (stillEnough(idle, now, readLastInput(lastPath))) break;
    if (!told) {
      console.log(`The owner is using the Mac (last touched ${Math.round(idle / 1000)} s ago): waiting until it has been still for ${STILL_MS / 1000} s...`);
      told = true;
    }
    if (now - start >= give) {
      console.log(`The owner kept using the Mac for ${Math.round(give / 1000)} s, so nothing was ${verb === 'type' ? 'typed' : 'clicked'}. Try again in a few minutes.`);
      return 3;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (told) console.log(`Still for ${STILL_MS / 1000} s after ${Math.round((Date.now() - start) / 1000)} s of waiting; going ahead.`);
  const ran = Date.now();
  const r = spawnSync('peekaboo', [verb, ...args], { stdio: 'inherit' });
  const done = Date.now();
  // When the Mac's last input event happened: the next command may go ahead early only while that
  // is still the last event. It counts as the room's own only when it happened while this command
  // ran; the owner touching the Mac in that same moment can't be told apart, so it's also left out
  // when the command took long enough for that to be likely.
  const after = idleMs();
  const at = after === undefined ? undefined : Date.now() - after;
  if (r.status === 0 && at !== undefined && ownEvent(at, ran, done)) writeLastInput(lastPath, at);
  else clearLastInput(lastPath);
  return r.status ?? 1;
}
