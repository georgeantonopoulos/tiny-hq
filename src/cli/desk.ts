// The owner's desk (src/team/desk.ts): put a report there for them to read as a page.
//   desk add "<title>" <report.md | -> [--from "<your name>"]   (Markdown; "-" reads it from stdin)
//   desk list

import { readFileSync } from 'node:fs';
import { DATA_DIR } from '../paths.ts';
import { fileReport, listReports } from '../team/desk.ts';

const [cmd, ...rest] = process.argv.slice(2);
const fail = (m: string): never => {
  console.error(m);
  process.exit(1);
};
const usage = 'usage: desk add "<title>" <report.md | -> [--from "<your name>"] | desk list';

if (cmd === 'list') {
  const list = listReports(DATA_DIR);
  if (!list.length) console.log('Nothing on the desk.');
  for (const r of list) console.log(`${r.id}  ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}  ${r.read ? 'read  ' : 'UNREAD'}  ${r.title} (from ${r.from})`);
} else if (cmd === 'add') {
  const fromAt = rest.indexOf('--from');
  const from = fromAt >= 0 ? (rest.splice(fromAt, 2)[1] ?? '') : process.env.CM_DESK_FROM ?? 'Manager';
  const [title, file] = rest;
  if (!title || !file) fail(usage);
  let md = '';
  try {
    md = readFileSync(file === '-' ? 0 : file!, 'utf8');
  } catch (err) {
    fail(`couldn't read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const r = fileReport(DATA_DIR, title!, md, from);
    console.log(`On the owner's desk: "${r.title}" (${r.id}). They'll see it marked unread on the floor; tell them in one line that it's there.`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
} else fail(usage);
