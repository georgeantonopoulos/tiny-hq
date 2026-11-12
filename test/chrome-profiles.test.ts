import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfiles, profileFor, renderProfiles, setProfile, siteKey } from '../src/team/profiles.ts';

// A list of which Chrome profile holds which sign-in, so rooms stop guessing the wrong one.
test('rooms note and look up which Chrome profile holds a sign-in', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'prof-')), 'chrome-profiles.json');
  assert.equal(siteKey('https://www.Harbor.com/123/projects'), 'harbor.com');
  setProfile(path, { site: 'https://harbor.com', profile: 'Work ("Profile 9")', how: 'no extension', by: 'Bo' }, 1);
  setProfile(path, { site: 'pypi.org', profile: 'Personal', how: 'Claude in Chrome: Browser 1', by: 'Val' }, 2);
  setProfile(path, { site: 'harbor.com', profile: 'Work ("Profile 9")', how: 'open with --profile-directory', by: 'Rosa' }, 3);
  const list = loadProfiles(path);
  assert.deepEqual(list.map((l) => l.site), ['harbor.com', 'pypi.org'], 'one line per site; a correction replaces it');
  assert.equal(profileFor(list, 'https://3.harbor.com/x')?.profile, 'Work ("Profile 9")', 'a sub-site finds its site');
  assert.equal(profileFor(list, 'play.google.com'), undefined);
  assert.match(renderProfiles(list), /pypi\.org: Personal · Claude in Chrome: Browser 1/);
  assert.throws(() => setProfile(path, { site: '', profile: 'x', how: '', by: '' }), /site and a profile/);
});

test('rooms and the manager are told to check it before any web console', () => {
  assert.match(readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8'), /manager\/profiles <site>/);
  assert.match(readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8'), /\{\{cli\}\}\/profiles <site>/);
});
