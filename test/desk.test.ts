import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReport, listReports, openReport, renderMarkdown, unreadCount } from '../src/team/desk.ts';
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
