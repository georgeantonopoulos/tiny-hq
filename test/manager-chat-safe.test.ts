import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DRAFT_TIMEOUT_MS, draftAfter, isDrafting } from '../src/terminal/sessions.ts';

// If the owner is typing to the manager on their phone, the office mustn't type Otto's report into the
// same box (Enter would send both as one message): it waits while they have an unsent message.
test("The owner's unsent message holds the office back until they send it", () => {
  const d: { since?: number; last?: number } = {};
  draftAfter(d, '\x1b[I', 1); // focus report: not typing
  draftAfter(d, '\x1b[A', 1); // arrow key: not typing
  assert.equal(isDrafting(d, 2), false);
  draftAfter(d, 'no one uses the coffee room', 10);
  assert.equal(isDrafting(d, 20), true);
  assert.equal(isDrafting(d, 10 + DRAFT_TIMEOUT_MS + 1), false, 'an abandoned draft stops holding after 10 minutes');
  draftAfter(d, '\r', 30);
  assert.equal(isDrafting(d, 31), false, 'Enter sends it');
  draftAfter(d, 'x', 40);
  draftAfter(d, '\x03', 41);
  assert.equal(isDrafting(d, 42), false, 'Ctrl-C clears it');
  draftAfter(d, '\x1b[200~line one\rline two\x1b[201~', 50);
  assert.equal(isDrafting(d, 51), true, 'a pasted block with line breaks is still unsent');
  draftAfter(d, '\x1b', 52);
  assert.equal(isDrafting(d, 53), true, "a lone Esc doesn't clear Claude's box");
  draftAfter(d, '\r', 54);
  assert.equal(isDrafting(d, 55), false);
  draftAfter(d, '\x1bOA', 60);
  assert.equal(isDrafting(d, 61), false, 'an arrow key in application mode is not typing');
});

test("the office's own lines wait for the owner's draft, and the manager's buttons ignore their chat", () => {
  const main = readFileSync(new URL('../src/daemon/main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(!owner && term\.drafting\(\)\) return 'later';/);
  assert.match(main, /!worksIn\(a\.folder, MANAGER_DIR\) && \(a\.sessionId \|\| a\.job\)\);/, "a line in the manager's chat never takes their own buttons down");
  const server = readFileSync(new URL('../src/daemon/server.ts', import.meta.url), 'utf8');
  assert.match(server, /term\.typed\(b\.data\)/, "the office page's keys count as the owner typing");
});
