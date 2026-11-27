import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LINKS, cachedIcon, fetchUrl, iconCandidates, iconPath, loadLinks } from '../src/office/quick-links.ts';
import { linkHref } from '../web/app/quick-links.ts';

test('quick links: the defaults are written out the first time, then the file is the list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'links-'));
  const file = join(dir, 'links.json');
  assert.deepEqual(loadLinks(file), DEFAULT_LINKS);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).links, DEFAULT_LINKS);
  writeFileSync(file, JSON.stringify({ links: [{ name: 'Dashboard', url: 'http://{here}:8765/' }, { name: 'bad', url: 'javascript:alert(1)' }, { name: 'nourl' }] }));
  assert.deepEqual(loadLinks(file), [{ name: 'Dashboard', url: 'http://{here}:8765/', emoji: '🔗' }], 'only http(s) links, a missing emoji gets the link sign');
  writeFileSync(file, '{ not json');
  assert.deepEqual(loadLinks(file), [], 'a broken file shows no links rather than taking the page down');
});

test('quick links: {here} is the address the page was opened at, the Mac when Tiny HQ fetches', () => {
  assert.equal(linkHref('http://{here}:8765/', 'my-mac.example.ts.net'), 'http://my-mac.example.ts.net:8765/');
  assert.equal(linkHref('https://github.com/', 'x'), 'https://github.com/');
  assert.equal(fetchUrl('http://{here}:8765/'), 'http://127.0.0.1:8765/');
});

test('quick links: a large touch icon beats a small favicon, and /favicon.ico is the last try', () => {
  const html = `<link rel="icon" href="/f16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180"><link rel="icon" href="data:,">`;
  assert.deepEqual(iconCandidates(html, 'https://example.com/a/'), ['https://example.com/touch.png', 'https://example.com/f16.png', 'https://example.com/favicon.ico']);
  assert.deepEqual(iconCandidates('', 'http://127.0.0.1:8765/'), ['http://127.0.0.1:8765/favicon.ico']);
});

test('quick links: icons are kept per site; a miss is tried again after a day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'icons-'));
  assert.deepEqual(cachedIcon(dir, 'https://github.com/'), { fresh: false });
  writeFileSync(iconPath(dir, 'https://github.com/'), JSON.stringify({ icon: 'data:image/png;base64,AA==' }));
  assert.equal(cachedIcon(dir, 'https://github.com/x').icon, 'data:image/png;base64,AA==', 'one icon per site, whatever the page');
  writeFileSync(iconPath(dir, 'https://none.example/'), JSON.stringify({}));
  assert.equal(cachedIcon(dir, 'https://none.example/').fresh, true);
  assert.equal(cachedIcon(dir, 'https://none.example/', Date.now() + 25 * 3600_000).fresh, false);
});

test('quick links: wired from the file to the floor', () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.match(read('src/daemon/server.ts'), /url\.pathname === '\/api\/links' && deps\.links/);
  assert.match(read('src/daemon/main.ts'), /links: \(\) => \(\{ links: linksForPage\(join\(DATA_DIR, 'links\.json'\)/);
  assert.match(read('web/index.html'), /<nav class="dock" id="dock"/);
  assert.match(read('web/app/main.ts'), /renderLinks\(\$\('dock'\), l, location\.hostname, \(n\) => api\.launchLink\(n\)\)/);
  assert.match(read('src/daemon/main.ts'), /launchLink: async \(name\) => \{\n\s+const r = await launchLink\(join\(DATA_DIR, 'links\.json'\)/);
  assert.match(read('src/daemon/server.ts'), /launchM && req\.method === 'POST' && deps\.launchLink/);
});

test('quick links: a program link starts its program once, detached, and the page never sees the command', async () => {
  const { launchLink, linksForPage } = await import('../src/office/quick-links.ts');
  const { createServer } = await import('node:net');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'launch-'));
  const port = await new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
  const script = join(dir, 'serve.sh');
  const pidFile = join(dir, 'pid');
  writeFileSync(script, `#!/bin/sh\necho $$ > ${pidFile}\nexec python3 -m http.server ${port} --bind 127.0.0.1\n`, { mode: 0o755 });
  const file = join(dir, 'links.json');
  writeFileSync(file, JSON.stringify({ links: [{ name: 'Brain', url: `http://{here}:${port}/`, emoji: '🧠', launch: [script] }, { name: 'Rel', url: 'http://x/', launch: ['rel/path'] }] }));
  const shown = linksForPage(file, join(dir, 'icons'));
  assert.equal((shown[0] as { launchable?: boolean }).launchable, true);
  assert.ok(!JSON.stringify(shown).includes(script), 'the command stays on the Mac');
  assert.equal((shown[1] as { launchable?: boolean }).launchable, undefined, 'a relative program path is ignored');
  assert.deepEqual(await launchLink(file, join(dir, 'logs'), 'Nope'), { ok: false, started: false, error: 'no such program link' });
  try {
    const a = launchLink(file, join(dir, 'logs'), 'Brain');
    const b = launchLink(file, join(dir, 'logs'), 'Brain');
    assert.equal(a, b, 'two clicks share one start');
    assert.deepEqual(await a, { ok: true, started: true });
    assert.deepEqual(await launchLink(file, join(dir, 'logs'), 'Brain'), { ok: true, started: false }, 'already answering: nothing new starts');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim());
    assert.equal(pgid, pid, 'its own process group, so an office restart leaves it running');
  } finally {
    try {
      process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
});
