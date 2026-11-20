// Reports on the owner's desk open as designed pages in a new tab, at low token cost. The office
// designs the page from the room's Markdown
// (no tokens), serves it at a signed link a plain tab can open, and shows a room's own .html cut off
// from the office and the internet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReport, linkValid, listReports, renderMarkdown, reportLink, reportPage, unreadCount } from '../src/team/desk.ts';
import { createDaemon } from '../src/daemon/server.ts';

test('a Markdown report becomes a whole designed page, marked read when opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpage-'));
  fileReport(dir, 'Spending <this> month', '# Spending\n\n| Payee | Amount |\n|---|---|\n| Amex | £1,200 |\n| Rent | **£950.50** |', 'Iris', 1, 'aaaaaaaa');
  const p = reportPage(dir, 'aaaaaaaa', 5)!;
  assert.equal(p.sandboxed, false);
  assert.match(p.html, /^<!doctype html>/);
  assert.match(p.html, /<title>Spending &lt;this&gt; month<\/title>/, 'the title is escaped');
  assert.match(p.html, /prefers-color-scheme:dark/, 'light and dark');
  assert.match(p.html, /<td class="num">£1,200<\/td>/, 'a column of amounts lines up');
  assert.match(p.html, /<td>Amex<\/td>/);
  assert.doesNotMatch(p.html, /https?:\/\//, 'nothing loads from outside');
  assert.equal(unreadCount(dir), 0);
});

test('a bars block draws a bar chart from plain lines', () => {
  const html = renderMarkdown('```bars\nBarclays: £1,200\nAmex: 300\nnot a number: x\n```');
  assert.match(html, /<div class="bars">/);
  assert.match(html, /<span>Barclays<\/span>.*width:100%.*£1,200/);
  assert.match(html, /<span>Amex<\/span>.*width:25%/);
  assert.doesNotMatch(html, /not a number/);
});

test("a room's own .html page is kept as it is and flagged to run sandboxed", () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskpage-'));
  fileReport(dir, 'Chart', '<!doctype html><script>draw()</script>', 'A room', 1, 'bbbbbbbb', undefined, true);
  assert.deepEqual(listReports(dir).map((r) => r.title), ['Chart']);
  const p = reportPage(dir, 'bbbbbbbb')!;
  assert.equal(p.sandboxed, true);
  assert.match(p.html, /draw\(\)/);
});

test('links are signed, run out after 12 hours, and fit only their own report', () => {
  const link = reportLink('secret', 'aaaaaaaa', 1000);
  const u = new URL(link, 'http://x');
  const e = u.searchParams.get('e');
  const k = u.searchParams.get('k');
  assert.equal(u.pathname, '/desk/aaaaaaaa');
  assert.ok(linkValid('secret', 'aaaaaaaa', e, k, 2000));
  assert.ok(!linkValid('secret', 'bbbbbbbb', e, k, 2000), 'another report');
  assert.ok(!linkValid('other', 'aaaaaaaa', e, k, 2000), 'another office');
  assert.ok(!linkValid('secret', 'aaaaaaaa', e, k, 1000 + 12 * 3_600_000 + 1), 'run out');
  assert.ok(!linkValid('secret', 'aaaaaaaa', String(Number(e) + 1), k, 2000), 'a changed time');
  assert.ok(!linkValid('secret', 'aaaaaaaa', e, null, 2000));
});

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((ok, no) => {
    const r = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on('error', no);
    r.end();
  });

test('the office serves a report page only on a good link, locked down, and the desk list carries the links', async () => {
  const pages: Record<string, { html: string; sandboxed: boolean }> = { aaaaaaaa: { html: '<p>md page</p>', sandboxed: false }, bbbbbbbb: { html: '<script>x</script>', sandboxed: true } };
  const port = 40000 + Math.floor(Math.random() * 20000);
  const d = createDaemon({ token: 't', port, floor: () => ({ rooms: [] }), desk: { list: () => ({ reports: [{ id: 'aaaaaaaa' }, { id: 'bbbbbbbb' }] }), page: (id) => pages[id], open: (id) => (id === 'aaaaaaaa' ? { id, title: 'A', html: '<p>a</p>' } : undefined), unread: () => 0 }, build: () => 'b1', sessions: async () => ({}) });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  try {
    const list = JSON.parse((await get(port, '/api/desk', { authorization: 'Bearer t' })).body) as { reports: { id: string; link: string }[] };
    const [a, b] = list.reports.map((r) => r.link);
    const md = await get(port, a!);
    assert.equal(md.status, 200);
    assert.equal(md.body, '<p>md page</p>');
    assert.match(String(md.headers['content-security-policy']), /default-src 'none'/);
    assert.doesNotMatch(String(md.headers['content-security-policy']), /script-src/, 'the office page runs no scripts');
    assert.equal(md.headers['referrer-policy'], 'no-referrer');
    const own = await get(port, b!);
    assert.match(String(own.headers['content-security-policy']), /^sandbox allow-scripts;/, "a room's page can't reach the office");
    assert.doesNotMatch(String(own.headers['content-security-policy']), /allow-same-origin|connect-src/);
    assert.equal((await get(port, '/desk/aaaaaaaa')).status, 404, 'no link, no page');
    assert.equal((await get(port, a!.replace('/desk/aaaaaaaa', '/desk/bbbbbbbb'))).status, 404);
    // A page opened before an update still uses the in-office reader: it must keep working.
    const old = await get(port, '/api/desk/aaaaaaaa', { authorization: 'Bearer t' });
    assert.equal(old.status, 200, 'the old reader still opens a report');
    assert.equal((JSON.parse(old.body) as { html: string }).html, '<p>a</p>');
    // The page learns the office's build so an open tab reloads after an update.
    const s = JSON.parse((await get(port, '/api/sessions', { authorization: 'Bearer t' })).body) as { build?: string };
    assert.equal(s.build, 'b1');
  } finally {
    d.close();
  }
});

test('the desk opens each report in a new tab through its link', () => {
  const desk = readFileSync(new URL('../web/app/desk.ts', import.meta.url), 'utf8');
  assert.match(desk, /document\.createElement\('a'\)[\s\S]{0,80}b\.href = rep\.link[\s\S]{0,40}b\.target = '_blank'/);
  assert.match(readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8'), /`bars`/);
});

test('an open office page reloads itself when the office is updated', () => {
  const main = readFileSync(new URL('../web/app/main.ts', import.meta.url), 'utf8');
  assert.match(main, /r\.build !== pageBuild && !isTyping\(\)\) return location\.reload\(\)/);
  assert.match(readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8'), /build: \(\) => webBuild\(\)/);
});

test("desk add confirms only what the office can open, and checking leaves it unread", async () => {
  const { officeOpens } = await import('../src/team/desk-check.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'desk-check-'));
  const tokenPath = join(dir, 'token');
  writeFileSync(tokenPath, 't');
  const peeks: boolean[] = [];
  const port = 40000 + Math.floor(Math.random() * 20000);
  const d = createDaemon({ token: 't', port, floor: () => ({ rooms: [] }), desk: { list: () => ({ reports: [{ id: 'aaaaaaaa' }, { id: 'cccccccc' }] }), page: (id, peek) => (peeks.push(!!peek), id === 'aaaaaaaa' ? { html: '<p>ok</p>', sandboxed: false } : undefined), open: () => undefined, unread: () => 0 } });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  try {
    assert.equal(await officeOpens('aaaaaaaa', port, tokenPath), undefined, 'a report the office opens passes');
    assert.deepEqual(peeks, [true], 'the check opens it without marking it read');
    assert.match((await officeOpens('cccccccc', port, tokenPath)) ?? '', /404/, 'listed but not openable fails');
    assert.match((await officeOpens('zzzzzzzz', port, tokenPath)) ?? '', /doesn't have it/);
    assert.match((await officeOpens('aaaaaaaa', port, join(dir, 'none'))) ?? '', /no office key/);
  } finally {
    d.close();
  }
  assert.match((await officeOpens('aaaaaaaa', port, tokenPath)) ?? '', /isn't answering/, 'office down fails');
  const cli = readFileSync(new URL('../src/cli/desk.ts', import.meta.url), 'utf8');
  assert.match(cli, /const why = await officeOpens\(r\.id\);\s*if \(why\) fail\(`NOT CONFIRMED/, 'desk add checks before saying it is on the desk');
});
