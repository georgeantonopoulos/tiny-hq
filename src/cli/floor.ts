// Who has a room on the floor (src/office/seats.ts). A room keeps its spot until the owner
// sends it to the archive cupboard on a button; this is how their pick is carried out.
//   floor list
//   floor away <room folder>   (only after the owner picked it on an ask button)
//   floor back <room folder>   (the owner asked for it back: it gets a spot now, even on a full floor)

import { realpathSync } from 'node:fs';
import { CONFIG_PATH, DATA_DIR } from '../paths.ts';
import { loadConfig } from '../config.ts';
import { bringBack, floorPath, loadSeats, saveSeats, sendAway } from '../office/seats.ts';

const usage = 'usage: floor list | floor away <room folder> (only after the owner picked it on a button) | floor back <room folder>';
const [cmd, arg] = process.argv.slice(2);
const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const path = floorPath(DATA_DIR);
const seats = loadSeats(path) ?? fail(`No ${path} yet: the office writes it on its first scan.`);
const folder = (p: string | undefined): string => {
  if (!p || !p.startsWith('/')) return fail(usage);
  try {
    return realpathSync(p);
  } catch {
    return p.replace(/\/+$/, ''); // a folder on a disk that isn't mounted right now
  }
};

if (cmd === 'list') {
  console.log(`On the floor (${seats.seated.length}):`);
  for (const p of seats.seated) console.log(`  ${p}`);
  if (seats.away.length) console.log(`Sent to the cupboard by the owner (${seats.away.length}):`);
  for (const p of seats.away) console.log(`  ${p}`);
} else if (cmd === 'away') {
  const f = folder(arg);
  if (!seats.seated.includes(f)) fail(`${f} has no spot on the floor (floor list).`);
  saveSeats(path, sendAway(seats, f));
  console.log(`${f} goes to the archive cupboard on the next floor scan (within 5 minutes, or when the floor page reloads).`);
} else if (cmd === 'back') {
  const f = folder(arg);
  saveSeats(path, bringBack(seats, f));
  const filed = loadConfig(CONFIG_PATH).archivedProjects.includes(f);
  console.log(
    filed
      ? `${f} has a spot again, but the office config also files it in the cupboard ("archivedProjects" in ${CONFIG_PATH}): take it out there and restart the office for it to show.`
      : `${f} is back on the floor from the next floor scan (within 5 minutes, or when the floor page reloads).`,
  );
} else fail(usage);
