// manager/coffee: a room posts to the coffee room board itself (no model, no tokens). Run from the
// room's folder or a worktree of it.
//   manager/coffee add <owner|tip|bug|mac> "<one line>"   share something another room would hit too
//   manager/coffee same <id>                               you hit a tip already listed: confirm it
//   manager/coffee list                                    the board and the tips waiting for a second room
// Posts only queue; the office files them on its next tick (src/team/coffee.ts applyPosts).

import { readFileSync, realpathSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { CONFIG_PATH, DATA_DIR } from '../paths.ts';
import { floorPath, loadSeats } from '../office/seats.ts';
import { roomOfFolder } from '../office/room-of-folder.ts';
import { outOfCoffee } from '../office/on-call.ts';
import { clean, KINDS, loadCoffee, minRooms, queuePost, secret, startupNote, startupPath, type TipKind } from '../team/coffee.ts';

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const fail = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};
const USAGE = 'Usage: manager/coffee add <owner|tip|bug|mac> "<one line>" | manager/coffee same <id> | manager/coffee list';

// The floor room this folder is, or is a worktree or clone of.
function myRoom(): string {
  const config = loadConfig(process.env.CM_CONFIG_PATH ?? CONFIG_PATH);
  if (!config.extras.coffee) fail('No post: the coffee room is switched off in this office.', 1);
  const here = real(process.cwd());
  const seats = loadSeats(floorPath(DATA_DIR));
  const room = seats && roomOfFolder(here, seats.seated.map(real));
  if (!room) fail(`No post: ${here} isn't a room on the office floor (or a worktree or clone of one). Run manager/coffee from your room's folder.`);
  if (outOfCoffee(room, config)) fail('No post: this room is kept out of the coffee room (private or on call).');
  return room!;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'list') {
  try {
    process.stdout.write(readFileSync(startupPath(DATA_DIR), 'utf8'));
  } catch {
    const s = loadCoffee(DATA_DIR);
    process.stdout.write(startupNote(s.tips, minRooms(s.rooms)));
  }
} else if (cmd === 'add') {
  const [kind, ...words] = rest;
  if (!kind || !(kind in KINDS)) fail(`Say what it's about: ${Object.keys(KINDS).join(', ')}. ${USAGE}`);
  const text = clean(words.join(' '), 240);
  if (text.length < 12) fail(`Say it in one line another room could use. ${USAGE}`);
  if (secret(text)) fail('No post: no links, code or anything like a credential on the board every room reads. Say it in plain words.');
  queuePost(DATA_DIR, { folder: myRoom(), at: Date.now(), kind: kind as TipKind, text });
  console.log('Posted. The office puts it on the board within a minute.');
} else if (cmd === 'same') {
  const id = rest[0]?.replace(/^\[|\]$/g, '') ?? '';
  if (!id) fail(USAGE);
  if (!loadCoffee(DATA_DIR).tips.some((t) => t.id === id)) fail(`No tip ${id} on the board. manager/coffee list shows the ids.`);
  queuePost(DATA_DIR, { folder: myRoom(), at: Date.now(), same: id });
  console.log("Confirmed. (A room's own tip doesn't count twice.)");
} else {
  fail(USAGE, cmd ? 2 : 0);
}
