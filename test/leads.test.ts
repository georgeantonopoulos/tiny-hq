import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackHires } from '../src/team/leads.ts';

test('without the naming model, every new room gets a different name from the list before any repeats', () => {
  const projects = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}` }) as Parameters<typeof fallbackHires>[0][number]);
  const names = fallbackHires(projects, new Set()).map((h) => h.name);
  assert.equal(new Set(names).size, 8);
  assert.ok(names.every((n) => !/\d$/.test(n)), `no numbered names while the list has free ones: ${names.join(', ')}`);
  const more = fallbackHires([{ id: 'p9' } as Parameters<typeof fallbackHires>[0][number]], new Set(names)).map((h) => h.name);
  assert.match(more[0]!, / 2$/, 'only when every name is taken does one get a number');
});
