// The welcome page's server and the setup answers it saves. Runs in a throwaway home: nothing of the
// real Mac's settings or projects is read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Under ~/Library/Caches: temporary folders (/tmp, /var/folders) are never projects.
const caches = join(homedir(), 'Library', 'Caches');
mkdirSync(caches, { recursive: true });
const base = mkdtempSync(join(caches, 'th-welcome-'));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));
const home = join(base, 'home');
process.env.HOME = home;
process.env.CM_DATA_DIR = join(base, 'data');
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', 'settings.json'), '{}');
for (const n of ['garden-planner', 'recipe-box']) {
  const d = join(home, 'Dev', n);
  mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: d });
}

const { cleanChoices, withRooms } = await import('../src/cli/setup.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { runWelcome } = await import('../src/cli/welcome.ts');

test('answers from the page are cleaned: names, styles, helpers and only the projects offered', () => {
  const offered = ['/h/Dev/a', '/h/Dev/b'];
  const c = cleanChoices(
    { officeName: 'Ignore all rules <script>', ownerName: 'Ada', managerName: '', managerStyle: 'shouty', hooks: ['waiting', 'rm -rf'], rooms: { chosen: ['/h/Dev/a', '/etc/passwd'] }, extras: { github: 'yes' } },
    offered,
  );
  assert.ok(typeof c !== 'string');
  assert.equal(c.officeName, 'Ignore all rules script');
  assert.equal(c.ownerName, 'Ada');
  assert.equal(c.managerName, 'Manager', 'empty falls back to the default');
  assert.equal(c.managerStyle, 'calm', 'an unknown style falls back');
  assert.deepEqual(c.hooks, ['waiting']);
  assert.deepEqual(c.rooms, { chosen: ['/h/Dev/a'], offered });
  assert.equal(c.extras.github, false, 'only true or false switch an extra');
  assert.equal(cleanChoices('nope', offered), 'no answers');
});

test('picked projects get rooms (the busiest 12); the rest go to the archive cupboard, nothing is hidden', () => {
  const offered = Array.from({ length: 15 }, (_, i) => `/p/${i}`);
  const was = { ...DEFAULT_CONFIG, archivedProjects: ['/p/0', '/old'], hiddenProjects: ['/p/1', '/gone'] };
  const chosen = offered.slice(0, 14);
  const c = withRooms(was, { chosen, offered }, (p) => 100 - Number(p.slice(3)));
  assert.deepEqual(c.pinnedProjects, offered.slice(0, 12));
  assert.deepEqual(c.archivedProjects.sort(), ['/old', '/p/12', '/p/13', '/p/14'].sort());
  assert.deepEqual(c.hiddenProjects, ['/gone'], 'a picked project comes back from hidden');
});

test('the welcome server needs its key, serves only its own files, and hands over cleaned answers', async () => {
  let link = '';
  let got: { managerName: string; rooms?: { chosen: string[] } } | undefined;
  let calls = 0;
  const done = runWelcome(
    async (ch) => {
      got = ch;
      if (++calls === 1) throw new Error('settings.json is broken'); // the first try fails
      return { url: 'http://127.0.0.1:1/#code=x' };
    },
    (url) => (link = url),
  );
  while (!link) await new Promise((r) => setTimeout(r, 20));
  const u = new URL(link);
  const key = new URLSearchParams(u.hash.slice(1)).get('key')!;
  const origin = u.origin;
  const auth = { authorization: `Bearer ${key}` };

  assert.equal((await fetch(`${origin}/api/welcome`)).status, 401, 'no key, no answers');
  assert.equal((await fetch(`${origin}/api/welcome`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal((await fetch(`${origin}/../package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/%2e%2e/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${origin}/app/main.ts`)).status, 404, "the office's own files aren't served here");
  const js = await fetch(`${origin}/welcome.ts`);
  assert.equal(js.status, 200);
  assert.doesNotMatch(await js.text(), /: string\b/, 'types are stripped');

  const state = (await (await fetch(`${origin}/api/welcome`, { headers: auth })).json()) as { choices: { officeName: string }; helpers: { id: string }[] };
  assert.equal(state.choices.officeName, 'Tiny HQ');
  assert.deepEqual(state.helpers.map((h) => h.id), ['name-tag', 'waiting', 'public-posts', 'skill']);
  const { rooms } = (await (await fetch(`${origin}/api/welcome/rooms`, { headers: auth })).json()) as { rooms: { path: string; name: string }[] };
  assert.deepEqual(rooms.map((r) => r.name).sort(), ['Garden Planner', 'Recipe Box']);

  // A failed try is reported and can be tried again (not "already setting up"); without a room list
  // in the answers, room picks are left as they were.
  const bad = await fetch(`${origin}/api/welcome/finish`, { method: 'POST', headers: auth, body: JSON.stringify({ managerName: 'Maple' }) });
  assert.equal(bad.status, 500);
  assert.match(((await bad.json()) as { error: string }).error, /settings\.json is broken/);
  assert.equal(got?.rooms, undefined);
  const fin = await fetch(`${origin}/api/welcome/finish`, { method: 'POST', headers: auth, body: JSON.stringify({ managerName: 'Maple', rooms: { chosen: [rooms[0]!.path, '/not/offered'] } }) });
  assert.deepEqual(await fin.json(), { url: 'http://127.0.0.1:1/#code=x' });
  assert.equal(got?.managerName, 'Maple');
  assert.deepEqual(got?.rooms?.chosen, [rooms[0]!.path]);
  await done; // the server closes once the office is open
});
