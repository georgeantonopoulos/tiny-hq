import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentModel } from '../src/terminal/sessions.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// A /model typed in a room's chat must show on the floor, not only the pick made on the room card.
test("a room's model is read from its session: a /model typed in the chat shows, not only the office's pick", () => {
  const home = mkdtempSync(join(tmpdir(), 'th-model-'));
  const cwd = '/Users/x/Dev/desk-lamp';
  const folder = join(home, '.claude', 'projects', '-Users-x-Dev-desk-lamp');
  mkdirSync(folder, { recursive: true });
  const put = (id: string, recs: unknown[]) => writeFileSync(join(folder, `${id}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const reply = (model: string, t: string) => ({ type: 'assistant', timestamp: t, message: { model, content: [{ type: 'text', text: 'ok' }] } });
  const switched = (name: string, t: string) => ({ type: 'user', timestamp: t, message: { role: 'user', content: `<local-command-stdout>Set model to \`${name}\` and saved as your default for new sessions</local-command-stdout>` } });

  // Switched in the chat, no reply yet: the switch shows at once.
  const a = '11111111-2222-4333-8444-555555555555';
  put(a, [reply('claude-opus-5-5', '2026-01-01T09:00:00Z'), switched('Sonnet 5.5', '2026-01-01T09:05:00Z')]);
  assert.deepEqual(currentModel(a, cwd, home), { model: 'sonnet', switchedAt: Date.parse('2026-01-01T09:05:00Z') });

  // A reply after the switch is the truth (and an error stand-in says nothing).
  const b = '21111111-2222-4333-8444-555555555555';
  put(b, [switched('Sonnet 5.5', '2026-01-01T09:05:00Z'), reply('claude-haiku-5-5', '2026-01-01T09:06:00Z'), reply('<synthetic>', '2026-01-01T09:07:00Z')]);
  assert.deepEqual(currentModel(b, cwd, home), { model: 'haiku', switchedAt: Date.parse('2026-01-01T09:05:00Z') });

  // Never switched: the reply's model, with no switch time (so it never overrides the owner's pick).
  const c = '31111111-2222-4333-8444-555555555555';
  put(c, [reply('claude-fable-5-2', '2026-01-01T09:00:00Z')]);
  assert.deepEqual(currentModel(c, cwd, home), { model: 'fable' });
  assert.equal(currentModel('41111111-2222-4333-8444-555555555555', cwd, home), undefined, 'no transcript');

  // Wiring: the daemon serves the live models on the status poll, and the page applies them to badges.
  const main = read('../src/daemon/main.ts');
  assert.match(main, /models: roomModels,/);
  assert.match(main, /cur\.switchedAt > pickedAt/, "only a /model newer than the owner's last card pick replaces it");
  assert.match(read('../web/app/main.ts'), /office\.showModels\(r\.models\)/);
});
