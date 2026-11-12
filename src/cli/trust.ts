// Used by manager/delegate before it starts a session:
//   trust.ts check <folder>                       exit 0 if Claude Code trusts it, 1 if not
//   trust.ts ask <folder> "<name>" "<task>"       put a "Trust and start" button over that room for
//                                                 The owner; their Approve trusts the folder and the office
//                                                 starts the session with this task.

import { MANAGER_NOTES_DIR } from '../paths.ts';
import { addAsk, asksPath, loadAsks, saveAsks } from '../team/asks.ts';
import { isTrusted } from '../terminal/trust.ts';

const [cmd, folder, name, task] = process.argv.slice(2);
if (cmd === 'check' && folder) process.exit(isTrusted(folder) ? 0 : 1);
if (cmd === 'ask' && folder && name && task) {
  const path = asksPath(MANAGER_NOTES_DIR);
  const question = `Trust ${folder.split('/').filter(Boolean).slice(-2).join('/')} for Claude Code and start ${name}'s session? (Claude Code won't start there until you do)`;
  const me = process.env.CLAUDE_CODE_SESSION_ID;
  saveAsks(path, addAsk(loadAsks(path), folder, question, Date.now(), undefined, me, undefined, undefined, !!me, { name, task }));
  console.log(
    `Claude Code doesn't trust ${folder} yet, so no session could start. The owner now has a "Trust and start" button over that room; ` +
      `when they approve, the office marks the folder trusted and starts the session with your task, and tells you. Don't ask them to type anything.`,
  );
  process.exit(3);
}
console.error('usage: trust.ts check <folder> | trust.ts ask <folder> "<name>" "<task>"');
process.exit(2);
