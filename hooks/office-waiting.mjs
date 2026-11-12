#!/usr/bin/env node
// PermissionRequest hook (global, in ~/.claude/settings.json): Claude Code is about to show a
// permission prompt, so this session is now waiting for the owner. Notes it in
// ~/.tiny-hq/waiting/<session_id>.json for the office, which puts a hand over that
// room's head (Claude Code still reports a session at a permission prompt as "working",
// so without this a room could sit on a prompt with nothing over its head).
// Never decides anything: prints nothing, so the normal prompt shows. Best effort, silent.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(process.env.CM_DATA_DIR ?? join(homedir(), '.tiny-hq'), 'waiting');

function note(input, now = Date.now()) {
  const id = typeof input?.session_id === 'string' ? input.session_id : '';
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return undefined;
  const tool = typeof input.tool_name === 'string' ? input.tool_name.slice(0, 80) : 'a tool';
  const ti = input.tool_input ?? {};
  const what = typeof ti.command === 'string' ? ti.command : typeof ti.file_path === 'string' ? ti.file_path : typeof ti.url === 'string' ? ti.url : '';
  return { id, row: { at: now, tool, what: what.replace(/\s+/g, ' ').trim().slice(0, 120), cwd: typeof input.cwd === 'string' ? input.cwd : '' } };
}

try {
  const n = note(JSON.parse(readFileSync(0, 'utf8') || '{}'));
  if (n) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${n.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(n.row), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
} catch {
  /* never in the way of the prompt */
}
process.exit(0);
