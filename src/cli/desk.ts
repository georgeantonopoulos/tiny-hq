// The owner's desk (src/team/desk.ts): put a report there for them to read as a page. Each report is a
// real file in a folder for what it is, inside the synced desk folder.
//   desk add "<title>" <report.md | -> [--from "<your name>"] [--folder "<folder>"]
//   desk list
//   desk where [<absolute folder>]   (show, or set, the synced folder; reports filed so far are copied in)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { copyFlatReports, deskDir, deskRoot, fileReport, folderFor, listDesk } from '../team/desk.ts';

const [cmd, ...rest] = process.argv.slice(2);
const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const usage = 'usage: desk add "<title>" <report.md | -> [--from "<your name>"] [--folder "<folder>"] | desk list | desk where [<folder>]';
const opt = (name: string): string | undefined => {
  const at = rest.indexOf(name);
  return at >= 0 ? (rest.splice(at, 2)[1] ?? '') : undefined;
};

if (cmd === 'list') {
  const { root, reports } = listDesk(DATA_DIR);
  console.log(`Desk folder: ${root}`);
  if (!reports.length) console.log('Nothing on the desk.');
  for (const r of reports) console.log(`${r.id}  ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}  ${r.read ? 'read  ' : 'UNREAD'}  ${r.folder || '(top)'} / ${r.title}${r.from ? ` (from ${r.from})` : ''}`);
} else if (cmd === 'where') {
  const to = rest[0];
  if (to) {
    if (!isAbsolute(to)) fail('give the full path of the folder');
    mkdirSync(deskDir(DATA_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(join(deskDir(DATA_DIR), 'where.json'), JSON.stringify({ root: to }, null, 2) + '\n', { mode: 0o600 });
    console.log(`Copied ${copyFlatReports(DATA_DIR)} report(s) into ${to}.`);
  } else console.log(deskRoot(DATA_DIR));
} else if (cmd === 'add') {
  const from = opt('--from') ?? process.env.CM_DESK_FROM ?? 'Manager';
  const folder = opt('--folder');
  const [title, file] = rest;
  if (!title || !file) fail(usage);
  let md = '';
  try {
    md = readFileSync(file === '-' ? 0 : file!, 'utf8');
  } catch (err) {
    fail(`couldn't read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const r = fileReport(DATA_DIR, title!, md, from, undefined, undefined, folder);
    const where = r.path ? `in "${r.path.slice(0, r.path.lastIndexOf('/'))}"` : `(kept in the office until the synced folder is back; it goes in "${folder || folderFor(r.title, r.from)}")`;
    console.log(`On the owner's desk: "${r.title}" (${r.id}) ${where}. They'll see it marked unread on the floor; tell them in one line that it's there.`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
} else fail(usage);
