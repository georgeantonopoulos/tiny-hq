import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { serveStatic } from '../src/daemon/web.ts';

// Fake response: records status, headers and body.
function get(path: string): { handled: boolean; status?: number; type?: string; body?: Buffer | string } {
  const out: { status?: number; type?: string; body?: Buffer | string } = {};
  const res = {
    writeHead: (s: number, h: Record<string, string>) => ((out.status = s), (out.type = h['content-type'])),
    end: (b: Buffer | string) => (out.body = b),
  } as unknown as ServerResponse;
  return { handled: serveStatic(path, res), ...out };
}

test('the page icons and the preview picture are served, with the real PNG bytes', () => {
  for (const p of ['/favicon.ico', '/icon-32.png', '/icon-192.png', '/thumbnail.png']) {
    const r = get(p);
    assert.ok(r.handled && r.status === 200 && r.type === 'image/png', p);
    assert.equal((r.body as Buffer).subarray(1, 4).toString(), 'PNG', `${p} is not intact`);
  }
  const svg = get('/icon.svg');
  assert.ok(svg.status === 200 && svg.type === 'image/svg+xml' && String(svg.body).startsWith('<svg'));
});

test('every icon the page links to exists', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(hrefs.length >= 3);
  for (const h of hrefs) assert.equal(get(h).status, 200, h);
});
