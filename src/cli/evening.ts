// The evening note (src/team/evening.ts): what a room decided or did that the owner hears about
// tonight, on their desk, instead of a button or a message now.
//   evening add "<what you decided or did, and why>" [--kind decision|merge|step|note]   (default: decision)
//   evening list      (what goes in tonight's note so far)

import { realpathSync } from 'node:fs';
import { DATA_DIR, MANAGER_DIR, MANAGER_NOTES_DIR } from '../paths.ts';
import { roomOfFolder, roomOfSession } from '../office/room-of-folder.ts';
import { floorPath, loadSeats } from '../office/seats.ts';
import { addEntry, eveningPath, KINDS, lastFiled, loadEntries, type Kind } from '../team/evening.ts';

const usage = `usage: evening add "<what you decided or did, and why>" [--kind ${Object.keys(KINDS).filter((k) => k !== 'expired').join('|')}] | evening list`;
const fail = (m: string): never => {
  console.error(m);
  process.exit(2);
};
const path = eveningPath(MANAGER_NOTES_DIR);
const [cmd, ...rest] = process.argv.slice(2);

// The room a line is filed under: the session's own room, else the room this folder is in or is a
// worktree of; without a floor record (or no match), the folder itself.
function room(f: string): string {
  const seats = loadSeats(floorPath(DATA_DIR));
  if (!seats) return f;
  const real = (r: string) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  };
  const rooms = [...seats.seated.map(real), real(MANAGER_DIR)];
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  return (session ? roomOfSession(session, rooms) : undefined) ?? roomOfFolder(f, rooms) ?? f;
}

if (cmd === 'list') {
  const since = lastFiled(MANAGER_NOTES_DIR);
  const rows = loadEntries(path).filter((e) => e.at > since);
  if (!rows.length) console.log("Nothing for tonight's note yet.");
  for (const e of rows) console.log(`${new Date(e.at).toTimeString().slice(0, 5)}  ${e.kind.padEnd(8)}  ${e.folder.split('/').pop()}: ${e.text}`);
} else if (cmd === 'add') {
  let kind: Kind = 'decision';
  const k = rest.indexOf('--kind');
  if (k >= 0) {
    const v = rest.splice(k, 2)[1] ?? '';
    if (!(v in KINDS) || v === 'expired') fail(usage);
    kind = v as Kind;
  }
  const text = rest.join(' ').trim();
  if (!text || text.startsWith('-')) fail(usage);
  const folder = room(realpathSync(process.cwd()));
  addEntry(path, { kind, folder, text }) ?? fail(usage);
  console.log("Added to tonight's evening note on the owner's desk. Nothing else to do: no button, no message to the manager.");
} else fail(usage);
