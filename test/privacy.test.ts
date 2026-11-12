import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// Tiny HQ is built from a private office. Nothing of that office's owner may ship: their names,
// accounts, rooms, people, tools only they use, or their Mac's paths. This test reads every file
// git would commit and fails on any of those words.
const root = new URL('..', import.meta.url).pathname;
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && f !== 'LICENSE' && !/\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(f) && !f.endsWith('pnpm-lock.yaml') && existsSync(root + f));

// Words that only ever belonged to the private office (not personal on their own, so they can live
// here). Written backwards, so this file doesn't trip the commit hook that checks for them.
const OFFICE_ONLY = ['yrag', 'reganam-edualc', 'rabxedoc', 'membo', 'enalhsad', 'namuh rm', 'ssob tseyako', 'asset', 'tpircsydit'].map((w) => new RegExp(`\\b${[...w].reverse().join('')}\\b`, 'i'));
// A real home folder: only the placeholder users the tests use are allowed.
const HOME_PATH = /\/Users\/(?!(?:g|x|t|test|someone|owner|me|you|alex|sam)\/|[a-z]+\/\.\.\.|<)[A-Za-z0-9._-]+\//;

// One file may name a few of these on purpose: the handy tools setup suggests. The owner chose to
// suggest the usage app and their own public memory-bank tool (which lives under their GitHub name).
// Only these words, only in that file.
// Written backwards, like the list above, so this file doesn't carry the words itself.
const ALLOWED: Record<string, string[]> = {
  'src/cli/tools.ts': ['rabxedoc', 'membo', 'egroeg', 'soluoponotna', 'soluoponotnaegroeg', 'lliks-knab-yromem-ilc-naidisbo'].map((w) => [...w].reverse().join('')),
};
const allowed = (f: string, word: string) => (ALLOWED[f] ?? []).includes(word.toLowerCase());

test('no word from the private office ships in Tiny HQ', () => {
  const hits: string[] = [];
  for (const f of files) {
    const lines = readFileSync(root + f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      for (const re of [...OFFICE_ONLY, HOME_PATH]) if (re.test(l) && !allowed(f, re.source.replace(/\\b/g, ''))) hits.push(`${f}:${i + 1}: ${re} in ${l.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});

// The full list of the owner's personal words is kept only on the maintainer's Mac (it would leak
// the very words it guards), in .claude/private-words.txt; the pre-commit hook checks it too.
test('no personal word from the local private list ships either', (t) => {
  const list = root + '.claude/private-words.txt';
  if (!existsSync(list)) return t.skip('no local private-words list on this Mac');
  const words = readFileSync(list, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter((w) => w && !w.startsWith('#'));
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(root + f, 'utf8').toLowerCase();
    for (const w of words) if (text.includes(w) && !allowed(f, w)) hits.push(`${f}: "${w}"`);
  }
  assert.deepEqual(hits, []);
});

// Text checks can't see inside pictures (a screenshot of the private office once nearly shipped as
// the page thumbnail). Every image and video must be one a person looked at: add or change one, and
// this fails until its hash is recorded here after checking it shows only demo data.
const REVIEWED: Record<string, string> = {
  'docs/office.png': 'c10fbc70f9c2e03b', // the demo office (made-up projects)
  'docs/tour-preview.gif': '23c4e4bcdb66dfea', // nine seconds of the tour
  'web/icon-192.png': '46962126d9f5aa7c', // the manager's pixel face
  'web/icon-32.png': '84c9a36cc77ad05b',
  'web/thumbnail.png': 'd2f273a3f76eeb52', // the demo office
};

test('every image and video has been looked at by a person', async () => {
  const { createHash } = await import('node:crypto');
  const media = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(f) && existsSync(root + f));
  const unreviewed = media.filter((f) => REVIEWED[f] !== createHash('sha256').update(readFileSync(root + f)).digest('hex').slice(0, 16));
  assert.deepEqual(unreviewed, [], 'look at these, then record their hashes in REVIEWED');
});
