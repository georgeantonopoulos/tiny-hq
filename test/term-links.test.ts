import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linksOnRow, type Buffer } from '../web/app/term-links.ts';

// A fake terminal: rows of `cols` cells; a wide character takes two cells (the second has width 0).
function term(rows: string[][], wrapped: boolean[]): Buffer {
  const lines = rows.map((cells, i) => ({
    isWrapped: wrapped[i] ?? false,
    length: cells.length,
    getCell: (x: number) => {
      const c = cells[x];
      if (c === undefined) return undefined;
      return c === '\0' ? { getChars: () => '', getWidth: () => 0 } : { getChars: () => c, getWidth: () => (/[　-鿿]/.test(c) ? 2 : 1) };
    },
  }));
  return { length: lines.length, getLine: (y: number) => lines[y] };
}
const row = (s: string, cols: number) => [...s.padEnd(cols)].slice(0, cols);

test('a link that wraps is found from either row, with the right cells', () => {
  const url = 'https://example.com/abcdef'; // 26 characters
  const b = term([row(url.slice(0, 20), 20), row(url.slice(20), 20)], [false, true]);
  const want = [{ range: { start: { x: 1, y: 1 }, end: { x: 6, y: 2 } }, text: url }];
  assert.deepEqual(linksOnRow(b, 1), want);
  assert.deepEqual(linksOnRow(b, 2), want, 'tapping the second row finds it too');
});

test('wide characters before a link take their two cells each', () => {
  // "中文 https://example.com": 中 and 文 are two cells each, so the link starts at cell 6.
  const cells = ['中', '\0', '文', '\0', ' ', ...'https://example.com'];
  const b = term([cells], [false]);
  assert.deepEqual(linksOnRow(b, 1), [{ range: { start: { x: 6, y: 1 }, end: { x: 24, y: 1 } }, text: 'https://example.com' }]);
});

test('only http(s) addresses are links', () => {
  const b = term([row('see javascript:alert(1) or ftp://x.y or https://ok.io/a.', 60)], [false]);
  assert.deepEqual(linksOnRow(b, 1).map((l) => l.text), ['https://ok.io/a']);
});
