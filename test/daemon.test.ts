import { readFileSync, unlinkSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, PASTES_DIR } from '../src/daemon/server.ts';
import { loadOrCreateToken } from '../src/daemon/token.ts';

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
          if (res.headers['content-type'] === 'text/event-stream' && body.includes('\n\n')) {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, body });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('token file is created private (0600)', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'cm-')), 'token');
  const t = loadOrCreateToken(p);
  assert.equal(t.length, 64);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(loadOrCreateToken(p), t);
});

async function freePort(): Promise<number> {
  // The daemon builds its host allowlist from the port it is given, so find one first.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

test('daemon: localhost only, token required, survives bad bodies', async () => {
  const port = await freePort();
  const d = createDaemon({ token: 'secret-token', port, floor: () => ({ rooms: [] }), sessions: async () => ({ manager: 'busy' }) });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  const auth = { authorization: 'Bearer secret-token' };
  try {
    assert.equal((await call(port, '/health')).status, 200);
    assert.equal((await call(port, '/api/floor')).status, 401);
    assert.equal((await call(port, '/api/floor', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await call(port, '/health', { host: 'evil.example:80' })).status, 421);
    assert.equal((await call(port, '/api/floor', { headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
    assert.deepEqual(JSON.parse((await call(port, '/api/sessions', { headers: auth })).body), { sessions: { manager: 'busy' }, said: {} });
    assert.equal((await call(port, '/api/login', { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await call(port, '/nope', { headers: auth })).status, 404);
    assert.equal((await call(port, '/health')).status, 200, 'still alive');
  } finally {
    d.close();
  }
});

test('terminals: token needed, bad requests refused, input and stream reach the session', async () => {
  const port = await freePort();
  const written: string[] = [];
  const sizes: [number, number][] = [];
  let closed = false;
  let exit: () => void = () => undefined;
  const term = {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: 'abcdef12',
    write: (d: string) => void written.push(d),
    resize: (c: number, r: number) => void sizes.push([c, r]),
    subscribe: (onData: (c: string) => void, onExit: () => void) => {
      onData('hello from claude');
      exit = onExit;
      return () => undefined;
    },
    close: () => void (closed = true),
    viewers: () => 0,
    ready: () => true,
    typed: (d: string) => void written.push(d), // the owner's keys reach the session too
    drafting: () => false,
  };
  const opens: [string, string][] = [];
  const d = createDaemon({
    token: 't',
    port,
    terminal: {
      open: async (p, mode) => {
        if (p !== '/Users/x/Dev/app') throw Object.assign(new Error('Not a project on the floor.'), { status: 404 });
        opens.push([p, mode]);
        return { termId: term.id, session: term.sessionId, fresh: true };
      },
      get: (id) => (id === term.id ? term : undefined),
    },
  });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  const headers = { authorization: 'Bearer t', 'content-type': 'application/json' };
  const post = (path: string, body: unknown, h: Record<string, string> = headers) => call(port, path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/term/open', { projectPath: '/Users/x/Dev/app' }, { 'content-type': 'application/json' })).status, 401);
    assert.equal((await post('/api/term/open', {})).status, 400, 'a folder is required');
    assert.equal((await post('/api/term/open', { projectPath: '/etc' })).status, 404, 'only floor projects');
    const ok = await post('/api/term/open', { projectPath: '/Users/x/Dev/app', mode: 'new' });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).session, 'abcdef12');
    assert.deepEqual(opens, [['/Users/x/Dev/app', 'new']]);
    // Anything but "new" or "resume" joins.
    await post('/api/term/open', { projectPath: '/Users/x/Dev/app', mode: 'rm -rf' });
    assert.deepEqual(opens[1], ['/Users/x/Dev/app', 'join']);
    // "resume" (reopening the last tab on load) reaches the daemon as itself: join only, never start.
    await post('/api/term/open', { projectPath: '/Users/x/Dev/app', mode: 'resume' });
    assert.deepEqual(opens[2], ['/Users/x/Dev/app', 'resume']);

    assert.equal((await post(`/api/term/${term.id}/input`, { data: 'ls\r' })).status, 200);
    assert.deepEqual(written, ['ls\r']);
    assert.equal((await post(`/api/term/${term.id}/input`, { data: 42 })).status, 400);
    assert.equal((await post(`/api/term/${term.id}/input`, { data: 'x'.repeat(70_000) })).status, 400, 'body or data too large');
    await post(`/api/term/${term.id}/resize`, { cols: 100, rows: 30 });
    assert.deepEqual(sizes, [[100, 30]]);
    // A pasted image: saved on the Mac, its path pasted into Claude.
    assert.equal((await call(port, `/api/term/${term.id}/image`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'text/plain' }, body: 'x' })).status, 415);
    const img = await call(port, `/api/term/${term.id}/image`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'image/png' }, body: 'fakepng' });
    assert.equal(img.status, 200);
    const pasted = /^\x1b\[200~(\/.+\.png)\x1b\[201~$/.exec(written.at(-1)!);
    assert.ok(pasted, 'the path goes in as a paste');
    assert.equal(readFileSync(pasted[1]!, 'utf8'), 'fakepng');
    unlinkSync(pasted[1]!);
    // A document from the paperclip (from a phone too): saved under its own name, path pasted.
    const doc = (name: string) => call(port, `/api/term/${term.id}/file`, { method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body: '%PDF-1' });
    assert.equal((await doc('notes.exe')).status, 415);
    assert.equal((await doc('../../etc/passwd')).status, 415);
    const pdf = await doc('Ομάδα notes/../Σελίδα 3.pdf');
    assert.equal(pdf.status, 200);
    const filed = /^\x1b\[200~(\/.+\/paste-[^/]+-Σελίδα-3\.pdf) \x1b\[201~$/.exec(written.at(-1)!);
    assert.ok(filed, written.at(-1));
    assert.equal(readFileSync(filed[1]!, 'utf8'), '%PDF-1');
    assert.ok(!filed[1]!.includes('..') && filed[1]!.startsWith(PASTES_DIR));
    unlinkSync(filed[1]!);
    written.length = 1;
    assert.equal((await post('/api/term/22222222-2222-4222-8222-222222222222/input', { data: 'x' })).status, 404, 'unknown terminal');
    assert.equal((await call(port, `/api/term/${term.id}/input`, { headers })).status, 405);

    const stream = await call(port, `/api/term/${term.id}/stream`, { headers });
    assert.equal(stream.status, 200);
    assert.match(stream.body, /data: "hello from claude"/);
    exit();
    await post(`/api/term/${term.id}/close`, {});
    assert.equal(closed, true);
  } finally {
    d.close();
  }
});

test('office page: served with a strict policy, same-origin only, nothing outside web/', async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const d = createDaemon({ token: 't', port, floor: () => ({ rooms: [] }) });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  const raw = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    const page = await raw('/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self';/);
    assert.doesNotMatch(String(page.headers['content-security-policy']), /unsafe-eval/);
    const js = await raw('/app/main.ts');
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /javascript/);
    assert.doesNotMatch(js.body, /: Room\)/, 'types are stripped');
    assert.equal((await raw('/vendor/pixi.js')).status, 200);
    // Traversal and other files are not served.
    for (const path of ['/app/%2e%2e/%2e%2e/package.json', '/app/..%2f..%2fpackage.json', '/app/../../package.json', '/vendor/../package.json']) {
      const r = await raw(path);
      assert.notEqual(r.status, 200, path);
      assert.doesNotMatch(r.body, /tiny-hq/, path);
    }
    assert.equal((await raw('/app/nope.ts')).status, 404);
    // The floor needs the token; same-origin browser calls are fine, other sites are refused.
    assert.equal((await raw('/api/floor')).status, 401);
    assert.equal((await raw('/api/floor', { authorization: 'Bearer t', origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await raw('/api/floor', { authorization: 'Bearer t', origin: 'http://evil.example' })).status, 403);
  } finally {
    d.close();
  }
});

test('one-time sign-in code: works once, needs the token to mint', async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const d = createDaemon({ token: 'the-token', port });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  const post = (path: string, body?: unknown, auth?: string) =>
    call(port, path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await post('/api/login-code')).status, 401, 'minting needs the token');
    const minted = await post('/api/login-code', undefined, 'the-token');
    const { code } = JSON.parse(minted.body) as { code: string };
    const first = await post('/api/login', { code });
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.body).token, 'the-token');
    assert.equal((await post('/api/login', { code })).status, 401, 'single use');
    assert.equal((await post('/api/login', { code: 'guess' })).status, 401);
    assert.equal((await call(port, '/app/%E0%A4%A', {})).status, 404, 'bad escape is a 404, not a crash');
  } finally {
    d.close();
  }
});

test('remote over Tailscale: the owner only, paired devices only, never the Mac token', async () => {
  const { Devices, RateLimit, remoteFrom } = await import('../src/daemon/remote.ts');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'cm-remote-'));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const rport = port + 1; // the Tailscale door
  const host = 'mac.tail1234.ts.net';
  const config = remoteFrom({ host, login: 'owner@example.com' })!;
  assert.equal(remoteFrom({ host: 'evil.com', login: 'a@b' }), undefined, 'only ts.net names');
  const auditPath = join(dir, 'audit.log');
  const opened: string[] = [];
  const spoken: string[] = [];
  const d = createDaemon({
    token: 'mac-token',
    port,
    terminal: { open: async (p) => (opened.push(p), { termId: '00000000-0000-4000-8000-000000000000', session: 'abcdef12', fresh: true }), get: () => undefined },
    say: async (t) => void spoken.push(t),
    remote: { config, devices: new Devices(join(dir, 'devices.json')), port: rport, signIns: new RateLimit(3, 60_000), auditPath },
  });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 50)); // the door opens right after
  const owner = { 'tailscale-user-login': 'owner@example.com' };
  const json = { 'content-type': 'application/json' };
  try {
    // Someone else on the tailnet (or nobody) gets nothing, not even the page.
    assert.equal((await call(rport, '/', { host, headers: { 'tailscale-user-login': 'friend@example.com' } })).status, 403);
    assert.equal((await call(rport, '/', { host })).status, 403);
    assert.equal((await call(rport, '/health', { host, headers: owner })).status, 200);
    // The Mac's own token is refused from outside.
    assert.equal((await call(rport, '/api/floor', { host, headers: { ...owner, authorization: 'Bearer mac-token' } })).status, 401);
    // Pairing: a link made on the Mac gives the phone its own key.
    const { code } = JSON.parse((await call(port, '/api/login-code?for=pairing', { method: 'POST', headers: { authorization: 'Bearer mac-token' } })).body) as { code: string };
    const paired = await call(rport, '/api/login', { method: 'POST', host, headers: { ...owner, ...json, origin: `https://${host}` }, body: JSON.stringify({ code }) });
    assert.equal(paired.status, 200);
    const key = (JSON.parse(paired.body) as { token: string }).token;
    assert.notEqual(key, 'mac-token');
    assert.equal((await call(rport, '/api/devices', { host, headers: { ...owner, authorization: `Bearer ${key}` } })).status, 200);
    // Even a paired phone can't make sign-in links.
    assert.equal((await call(rport, '/api/login-code', { method: 'POST', host, headers: { ...owner, authorization: `Bearer ${key}` } })).status, 403);
    // The key alone isn't enough without the owner's Tailscale identity.
    assert.equal((await call(rport, '/api/devices', { host, headers: { authorization: `Bearer ${key}` } })).status, 403);
    // The plain-http Tailscale address (no certificate) is the same page.
    assert.equal((await call(rport, '/api/devices', { host, headers: { ...owner, authorization: `Bearer ${key}`, origin: `http://${host}` } })).status, 200);
    // Other web pages can't ride along.
    assert.equal((await call(rport, '/api/devices', { host, headers: { ...owner, authorization: `Bearer ${key}`, origin: 'https://evil.example' } })).status, 403);
    // Used links fail, and guessing is rate-limited.
    assert.equal((await call(rport, '/api/login', { method: 'POST', host, headers: { ...owner, ...json }, body: JSON.stringify({ code }) })).status, 401);
    assert.equal((await call(rport, '/api/login', { method: 'POST', host, headers: { ...owner, ...json }, body: '{"code":"x"}' })).status, 401);
    assert.equal((await call(rport, '/api/login', { method: 'POST', host, headers: { ...owner, ...json }, body: '{"code":"x"}' })).status, 429);
    // From the phone, opening a terminal needs the owner's yes on the page first.
    const open = (body: unknown) => call(rport, '/api/term/open', { method: 'POST', host, headers: { ...owner, ...json, authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const unconfirmed = await open({ projectPath: '/p' });
    assert.equal(unconfirmed.status, 428);
    assert.equal(JSON.parse(unconfirmed.body).confirm, true);
    assert.equal((await open({ projectPath: '/p', confirm: true })).status, 200);
    assert.deepEqual(opened, ['/p'], 'only the confirmed open reached the terminal');
    // The mic works from the phone too (its own microphone, the browser's speech-to-text); it's logged.
    assert.equal((await call(rport, '/api/say', { method: 'POST', host, headers: { ...owner, ...json, authorization: `Bearer ${key}` }, body: '{"text":"hello from the phone"}' })).status, 200);
    assert.deepEqual(spoken, ['hello from the phone']);
    // Forgetting the device locks it out.
    const devs = JSON.parse((await call(port, '/api/devices', { headers: { authorization: 'Bearer mac-token' } })).body) as { items: { id: string; hash?: string }[] };
    assert.equal(devs.items[0]!.hash, undefined, 'key hashes are never sent out');
    await call(port, `/api/devices/${devs.items[0]!.id}/forget`, { method: 'POST', headers: { authorization: 'Bearer mac-token' } });
    assert.equal((await call(rport, '/api/floor', { host, headers: { ...owner, authorization: `Bearer ${key}` } })).status, 401);
    // Faking the Mac's own Host through the Tailscale door changes nothing: it's still remote.
    assert.equal((await call(rport, '/api/floor', { host: `127.0.0.1:${port}`, headers: { 'tailscale-user-login': 'friend@example.com', authorization: 'Bearer mac-token' } })).status, 403);
    assert.equal((await call(rport, '/api/floor', { host: `127.0.0.1:${port}`, headers: { ...owner, authorization: 'Bearer mac-token' } })).status, 401);
    // And the ts.net name on the Mac's own door is just a wrong host.
    assert.equal((await call(port, '/health', { host, headers: owner })).status, 421);
    const events = readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { event: string }).event);
    for (const e of ['refused', 'paired', 'session', 'terminal', 'say', 'forgotten']) assert.ok(events.includes(e), `audit has ${e}`);
  } finally {
    d.close();
  }
});

test('model picker: token needed, bad requests refused, choice passed on', async () => {
  const port = await freePort();
  const picked: [string, string][] = [];
  const d = createDaemon({
    token: 't',
    port,
    setModel: async (p, m) => {
      if (!['opus', 'sonnet', 'haiku'].includes(m)) throw Object.assign(new Error('Pick one of opus, sonnet, haiku.'), { status: 400 });
      picked.push([p, m]);
      return { applied: 'next' };
    },
  });
  await new Promise<void>((r) => d.listen(port, '127.0.0.1', r));
  const post = (body: unknown, auth = true) => call(port, '/api/model', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer t' } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ projectPath: '/p', model: 'sonnet' }, false)).status, 401);
    assert.equal((await post({ projectPath: '/p' })).status, 400);
    assert.equal((await post({ projectPath: '/p', model: 'gpt' })).status, 400);
    const ok = await post({ projectPath: '/p', model: 'sonnet' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { applied: 'next' });
    assert.deepEqual(picked, [['/p', 'sonnet']]);
  } finally {
    d.close();
  }
});
