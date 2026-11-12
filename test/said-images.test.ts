import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imagesIn } from '../src/terminal/sessions.ts';

// Pictures a message points at show in its bubble, so the owner can see what a room made.
test('a message\'s pictures are the image files it names that exist, at most four', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-pics-'));
  const real = (n: string) => {
    const p = join(dir, n);
    writeFileSync(p, 'x');
    return p;
  };
  const a = real('a.png');
  const b = real('shot two.jpg'); // a space: not read as a path
  const c = real('c.webp');
  const text = `Screens: ${a}, (${c}) and ${b}; also ${join(dir, 'gone.png')} and ${a} again, and notes ${join(dir, 'x.txt')}`;
  assert.deepEqual(imagesIn(text), [a, c]);
  assert.deepEqual(imagesIn(`~/pics/one.png`, dir), []); // ~ is the home given, and it isn't there
  const many = Array.from({ length: 6 }, (_, i) => real(`p${i}.png`));
  assert.equal(imagesIn(many.join(' ')).length, 4);
});

// A picture sent with SendUserFile ({ files: [...] }) a few steps before the final message used to
// leave the bubble without it.
test('a picture sent with SendUserFile earlier in the same turn shows with the final message', async () => {
  const { mkdirSync } = await import('node:fs');
  const { lastSaid } = await import('../src/terminal/sessions.ts');
  const home = mkdtempSync(join(tmpdir(), 'cm-home-'));
  const pic = join(home, 'before-after.png');
  writeFileSync(pic, 'x');
  const old = join(home, 'old.png');
  writeFileSync(old, 'x');
  const cwd = '/Users/x/Dev/tiny-hq';
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const id = '11111111-2222-4333-8444-555555555555';
  const A = (content: unknown[], at: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { content } });
  const U = (content: unknown) => JSON.stringify({ type: 'user', message: { content } });
  writeFileSync(join(dir, `${id}.jsonl`), [
    A([{ type: 'tool_use', name: 'SendUserFile', input: { files: [old] } }], '1'), // an earlier turn
    U('fix the banner'),
    A([{ type: 'tool_use', name: 'SendUserFile', input: { files: [pic], caption: 'before/after' } }], '2'),
    U([{ type: 'tool_result', content: 'sent' }]),
    A([{ type: 'text', text: 'Fixed; I sent you the before/after picture.' }], '3'),
  ].join('\n') + '\n');
  const r = lastSaid(id, cwd, home)!;
  assert.equal(r.at, '3');
  assert.deepEqual(r.images, [pic]);
});
