// manager/ask: put a yes/no question for the owner on the office floor, as a button
// over your head. Their answer arrives in your own chat as a message from them.
//   ask "<one-line question>" --why <reason> --tried "<what you already tried>"   (from your project folder)
//   ask "<what and where>" --why post --tried "..." --text "<exact text>" --target <owner/repo#N | owner/repo | https://page>   (a public post: the pass is for that text at that place only)
//     reason: send | post | pay | choice | permission | password (src/team/only-owner.ts); anything else is refused
//   ask "<question>" --why choice --tried "..." --choices "<option>" "<option>" [...]   (2 to 6: the owner picks one)
//   ask --room "<room folder>" "<question>" --choices ...   (The manager: the button goes over that room's
//                                 head, and the owner's pick still comes back to your own chat)
//   ask list
//   ask cancel                    (this folder's open questions, and any you put over a room)

import { normTarget } from '../team/posts.ts';
import { realpathSync, statSync } from 'node:fs';
import { MANAGER_NOTES_DIR } from '../paths.ts';
import { checkOnlyOwner, takeOnlyOwner } from '../team/only-owner.ts';
import { addAsk, afterCancel, asksPath, loadAsks, MAX_OPTIONS, roomsOwnQuestion, saveAsks, validOptions } from '../team/asks.ts';

const path = asksPath(MANAGER_NOTES_DIR);
// --why / --tried can go anywhere on the line.
const proofArgs = takeOnlyOwner(process.argv.slice(2));
let args = proofArgs.rest;
// --text "<exact text>": the exact words a --why post button asks the owner to approve.
// --target <where>: the PR or issue (owner/repo#N), the repo for a new issue (owner/repo), or the page URL.
let postText: string | undefined;
let postTarget: string | undefined;
for (const [flag, set] of [['--text', (v: string) => (postText = v)], ['--target', (v: string) => (postTarget = v)]] as const) {
  const i = args.indexOf(flag);
  if (i >= 0) {
    set(args[i + 1] ?? '');
    args = [...args.slice(0, i), ...args.slice(i + 2)];
  }
}
let folder = realpathSync(process.cwd());
let askedFor = false;
const me = process.env.CLAUDE_CODE_SESSION_ID;
// --room: the question is about another room (The manager's daily-brief next move), so it shows over that room's head.
if (args[0] === '--room') {
  try {
    const room = realpathSync(args[1] ?? '');
    if (!statSync(room).isDirectory()) throw new Error('not a folder');
    folder = room;
    askedFor = true;
  } catch {
    console.error(`ask --room: "${args[1] ?? ''}" is not a folder`);
    process.exit(2);
  }
  args = args.slice(2);
  // The owner's answer must come back to the asker, never to the room's own session.
  if (!me) {
    console.error('ask --room needs to run inside a Claude Code session (CLAUDE_CODE_SESSION_ID is not set)');
    process.exit(2);
  }
}
const asks = loadAsks(path);

if (args[0] === 'list') {
  if (!asks.length) console.log('No open questions.');
  for (const a of asks) console.log(`${a.id}  ${a.folder}  ${a.question}${a.options ? `  [${a.options.join(' | ')}]` : ''}`);
} else if (args[0] === 'cancel') {
  const left = afterCancel(asks, folder, me, askedFor);
  saveAsks(path, left);
  console.log(`Cancelled ${asks.length - left.length} open question${asks.length - left.length === 1 ? '' : 's'}.`);
} else {
  const at = args.indexOf('--choices');
  const question = (at < 0 ? args : args.slice(0, at)).join(' ').trim();
  const choices = at < 0 ? undefined : validOptions(args.slice(at + 1));
  // A flag that isn't --choices (--help, -h) is not a question for the owner.
  if (!question || question.startsWith('-') || (at >= 0 && !choices)) {
    console.error(`usage: ask "<one-line yes/no question for the owner>" --why <reason> --tried "<what you tried>" | ask "<question>" --why choice --tried "..." --choices "<option>" "<option>" ... (2 to ${MAX_OPTIONS} different options) | ask list | ask cancel`);
    process.exit(2);
  }
  // The room already asks the owner itself: a second button over the same head would ask them twice.
  const own = askedFor ? roomsOwnQuestion(asks, folder) : undefined;
  if (own) {
    console.error(`Not added: that room already has its own question up for the owner (${own.id}: "${own.question.slice(0, 120)}"). Their answer goes straight to the room; don't ask them the same thing twice. If yours is different, ask the room to add it to its own question, or wait until they have answered.`);
    process.exit(2);
  }
  // Only the owner's things reach the owner: a reason from the short list, and what was already tried.
  const refused = checkOnlyOwner(proofArgs.why, proofArgs.tried);
  if (refused) {
    console.error(`No button for the owner.\n${refused}`);
    process.exit(2);
  }
  const why = proofArgs.why!.trim().toLowerCase();
  // Button-only posts: a post's button carries its exact text; Approve passes only that text.
  if (why === 'post' && (!postText || !postText.trim() || choices)) {
    console.error('A post needs its exact text on the button: ask "<what and where>" --why post --tried "<what you did>" --text "<the exact text to post>" (yes/no, no --choices). The owner approves that text; only it can then be posted, once.');
    process.exit(2);
  }
  // Each pass is for one place.
  if (why === 'post' && !normTarget(postTarget)) {
    console.error('A post needs where it goes on the button too: --target owner/repo#<number> for a PR or issue comment or review, owner/repo for a new issue, or the full https:// URL of the page for another site. The owner approves the text for that place only.');
    process.exit(2);
  }
  // Claude Code tells its shell which session this is: the answer goes back to exactly this one.
  saveAsks(path, addAsk(asks, folder, question, Date.now(), undefined, me, undefined, choices, askedFor, undefined, { why, tried: proofArgs.tried!, ...(why === 'post' ? { post: postText, target: normTarget(postTarget) } : {}) }));
  console.log(
    choices
      ? `The owner now sees a question mark over your head; tapping it shows your question with ${choices.length} buttons: ${choices.map((c) => `"${c}"`).join(', ')}. Their pick will arrive in this chat as "The owner chose: ..."; stop here and wait for it.`
      : 'The owner now sees a question mark over your head; tapping it shows your question with Approve / No. Their answer will arrive in this chat as a message from them; stop here and wait for it.',
  );
}
