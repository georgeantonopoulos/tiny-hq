import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFlatReports, fileReport, folderFor, listDesk, listReports, openReport, renderMarkdown, shortRoot, unreadCount } from '../src/team/desk.ts';
import { layoutFloor } from '../src/office/layout.ts';

// A report the owner asks for waits on their desk as a readable page.
test("reports land on the owner's desk, newest first, unread until they open one", () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  fileReport(dir, 'Atlas sales', '# Sales\n\n10 paid copies', 'Cora', 1, 'aaaaaaaa');
  fileReport(dir, 'Lumen review', 'All good', 'Manager', 2, 'bbbbbbbb');
  assert.deepEqual(listReports(dir).map((r) => r.title), ['Lumen review', 'Atlas sales']);
  assert.equal(unreadCount(dir), 2);
  const r = openReport(dir, 'aaaaaaaa', 5)!;
  assert.match(r.html, /<h1>Sales<\/h1>/);
  assert.equal(r.read, 5);
  assert.equal(unreadCount(dir), 1);
  assert.equal(openReport(dir, '../../etc', 5), undefined, 'ids are checked: no paths');
  assert.throws(() => fileReport(dir, ' ', 'x', 'Manager'), /title/);
});

test('reports are Markdown made into safe HTML: nothing a session writes can run in the page', () => {
  const html = renderMarkdown(['## Last 30 days', '', '| Metric | Value |', '|---|---|', '| Sales | **$29** |', '', '- one', '- two', '', '<script>alert(1)</script> <img src=x onerror=alert(1)>', '[ok](https://apple.com) [bad](javascript:alert(1))', '`<b>`'].join('\n'));
  assert.match(html, /<h2>Last 30 days<\/h2>/);
  assert.match(html, /<table>.*<th>Metric<\/th>.*<td><strong>\$29<\/strong><\/td>/s);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.doesNotMatch(html, /<script|<img|onerror=alert\(1\)>|href="javascript/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/apple.com" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
});

test("The owner's desk is a room on the floor, and the page opens it", () => {
  const floor = layoutFloor([]);
  assert.ok(floor.rooms.some((r) => r.id === 'desk' && r.kind === 'desk'));
  const office = readFileSync(new URL('../web/app/office.ts', import.meta.url), 'utf8');
  assert.match(office, /room\.kind === 'desk'\) handlers\.onDesk/);
  const main = readFileSync(new URL('../web/app/main.ts', import.meta.url), 'utf8');
  assert.match(main, /office\.showDesk\(r\.deskUnread\)/);
  // The manager and the rooms are told to use it.
  assert.match(readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8'), /\{\{cli\}\}\/desk add/);
  assert.match(readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8'), /manager\/desk add/);
});

// Reports grouped by what they are, as real files that can sit in a synced folder.
test('each report is a real file in a folder for what it is, inside the synced desk folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  const drive = mkdtempSync(join(tmpdir(), 'drive-'));
  // An old flat report, from before the folders.
  fileReport(dir, 'Atlas sales: last 30 days', '# Sales', 'Cora', Date.UTC(2026, 10, 10), 'aaaaaaaa');
  writeFileSync(join(dir, 'desk', 'where.json'), JSON.stringify({ root: join(drive, 'Office Desk') }));
  // Moving the desk copies it into the tree; the original stays.
  assert.equal(copyFlatReports(dir), 1);
  assert.ok(existsSync(join(drive, 'Office Desk', 'Money and sales', 'Atlas sales- last 30 days (2026-11-10).md')));
  assert.ok(existsSync(join(dir, 'desk', 'aaaaaaaa.md')), 'the original stays');
  assert.equal(copyFlatReports(dir), 0, 'copied once');
  fileReport(dir, 'Evening note, 17 Nov', 'x', 'The office', Date.UTC(2026, 10, 17), 'bbbbbbbb');
  fileReport(dir, 'npm package: security scan', 'x', 'Sam', Date.UTC(2026, 10, 12), 'cccccccc');
  fileReport(dir, 'Garden app answers', 'x', 'Pip', Date.UTC(2026, 10, 13), 'dddddddd', 'Garden app');
  assert.deepEqual(
    listDesk(dir).reports.map((r) => [r.id, r.folder]),
    [['bbbbbbbb', 'Evening notes'], ['dddddddd', 'Garden app'], ['cccccccc', 'Security'], ['aaaaaaaa', 'Money and sales']],
  );
  // The owner moves one in Finder and adds a file and a folder of their own: the desk shows the disk.
  mkdirSync(join(drive, 'Office Desk', 'Archive'));
  renameSync(join(drive, 'Office Desk', 'Security'), join(drive, 'Office Desk', 'Archive', 'Security'));
  writeFileSync(join(drive, 'Office Desk', 'My notes.md'), '# Mine');
  mkdirSync(join(drive, 'Office Desk', 'Empty one'));
  symlinkSync('/etc/hosts', join(drive, 'Office Desk', 'sneaky.md'));
  const after = listDesk(dir);
  const sec = after.reports.find((r) => r.id === 'cccccccc')!;
  assert.equal(sec.folder, 'Archive/Security', 'a moved report keeps who filed it');
  assert.equal(sec.from, 'Sam');
  const mine = after.reports.find((r) => r.title === 'My notes')!;
  assert.equal(mine.folder, '');
  assert.match(openReport(dir, mine.id)!.html, /<h1>Mine<\/h1>/);
  assert.ok(after.folders.includes('Empty one'));
  assert.ok(!after.reports.some((r) => r.title === 'sneaky'), 'symlinks are never read');
  assert.equal(openReport(dir, 'cccccccc', 9)!.read, 9);
  assert.equal(folderFor('Atlas: changes since v0.2.41'), 'Releases and changes');
  assert.equal(folderFor('Audit of the manager, 13 Nov'), 'Office');
  assert.equal(folderFor('Weekly answers', 'Manager'), 'Office');
  assert.equal(folderFor('Μελέτη: Το Ιερό Πυρ'), 'Research and answers');
});

test('when the synced drive is away, a report waits in the office and goes over later', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-'));
  const drive = join(mkdtempSync(join(tmpdir(), 'drive-')), 'My Drive');
  mkdirSync(join(dir, 'desk'), { recursive: true });
  writeFileSync(join(dir, 'desk', 'where.json'), JSON.stringify({ root: join(drive, 'Office Desk') }));
  const r = fileReport(dir, 'Usage leak', 'x', 'Tess', 1, 'eeeeeeee');
  assert.equal(r.path, undefined);
  assert.ok(existsSync(join(dir, 'desk', 'eeeeeeee.md')));
  assert.equal(listDesk(dir).reports[0]!.id, 'eeeeeeee', 'still on the desk');
  mkdirSync(drive);
  assert.equal(copyFlatReports(dir), 1);
  assert.equal(listDesk(dir).reports[0]!.folder, 'Office');
});

test('the page draws the desk as a folder tree, under the synced drive\'s own name', () => {
  const page = readFileSync(new URL('../web/app/desk.ts', import.meta.url), 'utf8');
  assert.match(page, /export function deskTree/);
  assert.match(page, /'details'/);
  assert.equal(shortRoot('/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/Office Desk', '/Users/sam'), 'iCloud Drive/Office Desk');
  assert.equal(shortRoot('/Users/sam/Library/CloudStorage/GoogleDrive-x@y.z/My Drive/Desk', '/Users/sam'), 'Google Drive/My Drive/Desk');
  assert.equal(shortRoot('/Users/sam/.tiny-hq/desk/folders', '/Users/sam'), '~/.tiny-hq/desk/folders');
});
