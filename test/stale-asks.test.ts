import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A job's own button (made by `job wait`, with no session) must come down when the owner answers
// in any of the room's chats, worktree sessions included, not only buttons tied to one chat.
test("a job's button goes when the owner talks in any of its room's chats, worktrees included", () => {
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  assert.match(main, /\(a\.sessionId \|\| a\.job\)\);/);
  assert.match(main, /all\.filter\(\(x\) => x\.sessionId && worksIn\(x\.realCwd, a\.folder\)\)/);
});

// Browsers only lend the mic to secure pages, so over plain http the mic says so instead of
// failing silently.
test('the mic explains itself on an insecure page', () => {
  const top = readFileSync(new URL('../web/app/topbar.ts', import.meta.url), 'utf8');
  assert.match(top, /if \(Rec && !globalThis\.isSecureContext\)/);
});
