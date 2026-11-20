// Only the owner: the short list of things a session may hand to the owner, and the
// check every button for them goes through (manager/ask, manager/job wait). A button
// must say why only the owner can do it (one of the reasons below) and what the
// asker already tried. Everything else, a room or the manager does itself; a broken
// office tool goes to the manager as an office fault, not to the owner.
// (Without it, most of what reaches the owner isn't theirs to do.)

export const REASONS = {
  post: 'put exact text on a public site (posts, comments, replies, reviews, DMs, uploads)',
  pay: 'pay or commit money',
  irreversible: 'a step that cannot be undone (deleting data or an account, a release that cannot be pulled back): say what would be lost',
  choice: 'a choice that changes what the owner gets (which data source, design or approach they will live with): put the options on --choices, your recommendation first. Small, reversible mechanics you decide yourself and write in the evening note',
  permission: 'approve one exact command or tool their settings refuse (name it)',
  hands: 'a step only their hands can do, such as a switch in macOS System Settings (open the exact pane or window yourself first and ask only for that one click, never a list of steps; their button reads Done, I did it / Stuck)',
  camera: 'turn on the camera or microphone of their Mac (say what for and the exact command; their Approve lets that one capture run once, within 2 hours)',
  password: 'type a password or a 2-factor code that no session has (their Chrome is not already signed in)',
} as const;

export type Reason = keyof typeof REASONS;

export const ONLY_OWNER_HELP = [
  'A button for the owner needs --why <reason> and --tried "<what you already tried>".',
  'Reasons (nothing else goes to the owner):',
  ...Object.entries(REASONS).map(([k, v]) => `  ${k}: ${v}`),
  "Not the owner's: a broken office tool or connector (tell the manager: it's an office fault), a sign-in their Chrome already has (do it in Chrome yourself),",
  'closing or restarting sessions (the office does it), uploads, forms and console buttons (do them yourself).',
].join('\n');

const MIN_TRIED = 12;
export const cleanLine = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Pull --why and --tried out of a command line. Returns the other args untouched.
export function takeOnlyOwner(args: string[]): { rest: string[]; why?: string; tried?: string } {
  const rest: string[] = [];
  let why: string | undefined;
  let tried: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--why') why = args[++i];
    else if (args[i] === '--tried') tried = args[++i];
    else rest.push(args[i]!);
  }
  return { rest, ...(why !== undefined ? { why } : {}), ...(tried !== undefined ? { tried } : {}) };
}

// Rooms may put a choice on a button (--why choice --choices "<pick>" "<other>") when it changes what
// the owner gets; small, reversible mechanics they still decide themselves and put in the evening note.
// (Refusing every room choice left the owner unable to steer the choices that were theirs.)

// The --why list as rooms are told it ("post|pay|..."), so every message names the same reasons.
export const WHY_LIST = Object.keys(REASONS).join('|');

// An email is never a button: the owner sends their own emails, when they like. A room leaves it as a
// draft in their mail; a job about an email is done once the draft is saved.
// (A "send this email" button asks for a yes the owner can give more simply by pressing Send.)
export const NO_SEND_BUTTON =
  'An email is never a button: the owner sends their own emails, when they like. Leave it as a draft in their mail, tell the manager it is ready, and finish (a job about an email is done once the draft is saved). No --why send.';

// Rooms merge their own PRs: once the tests pass and an independent review is clean, the room merges
// and lists it in the evening note. Releases, store submissions and public deploys stay the owner's.
// (Handing the owner a "ready for you to merge" for a clean PR is a click they gain nothing from.)
// This one sentence is what rooms are told everywhere (the theoffice skill, goal steps, the
// manager's rules); test/merge-rule.test.ts fails if a text that tells rooms about merging leaves it out.
export const MERGE_RULE =
  'Merging is yours: when your PR\'s tests pass and an independent review is clean (your validator subagent, and the Codex or CodeRabbit comments on the PR, each answered), merge it yourself and list it in the evening note (manager/evening add "<PR and what it does>" --kind merge); never put a Merge button up. Still the owner\'s: releases and store submissions, public deploys (including a merge that publishes a site by itself), and a repo whose own rules say a person merges.';

// A Merge button (question or options about merging a PR or branch) is refused, unless the merge is
// a release or public deploy (the owner's, as a post) or a command their settings refuse (permission).
// Only what is asked counts: the question's "?" sentences (all of it if it has none) and the options.
// A sentence of background that mentions a merge doesn't make the button a Merge button.
// (A merge conflict to resolve, or an option named "Merge" with no PR or branch in sight, e.g. a
// compositing Merge node, is not a merge of code.)
const MERGE_WORD = /\bmerg(e|es|ing)\b(?! conflicts?)/i;
const CODE_REF = /\bPRs?\b|\bpull request|#\d+|\bbranch(es)?\b|\b(main|master)\b/i;
const PUBLIC_STEP = /\b(release|deploy|publish|app store|store submission|testflight|go(es)? (live|public)|live on)\b|\bputs? [^.?!|]{0,40}\blive\b/i;
function askedPart(text: string): string {
  const [question = '', ...options] = text.split(' | ');
  const asked = question.match(/[^.?!]*\?/g);
  return [asked ? asked.join(' ') : question, ...options].join(' | ');
}
export function mergeButton(why: string, text: string): string | undefined {
  if (why === 'post' || why === 'permission' || why === 'password') return undefined;
  if (!MERGE_WORD.test(askedPart(text)) || !CODE_REF.test(text) || PUBLIC_STEP.test(text)) return undefined;
  return `No Merge button. ${MERGE_RULE} (Review not clean yet: fix what it found first. Merging would release or deploy something publicly: say so on a --why post button. Their settings refuse the merge command: --why permission, naming the exact command.)`;
}

// A sign-in button names the logins already checked: the owner shouldn't be asked to sign in to a
// service while its command-line tool is already signed in on the Mac, or another room holds a key
// for it. Every password button, and a hands button about signing in, must say in --tried which
// existing logins were looked at.
const SIGN_IN = /\b(sign(ed|ing)?[ -]?in|log(ged|ging)?[ -]?in|login|account|credentials?|api key|token|2fa|two[- ]factor|password|passkey|authori[sz]e|auth)\b/i;
const LOGINS_CHECKED = /\bwhoami\b|\bauth (status|list)\b|\bprofiles?\b|\b(signed|logged) in\b|\bkeychain\b|\bapi[- ]?keys?\b|\btokens?\b|\.env\b|\bcredentials?\b|\bother rooms?\b/i;
export const LOGIN_PLACES =
  'Before asking the owner to sign in, look for a login the Mac or another room already has: the command-line tool\'s own sign-in (wrangler whoami, gh auth status, vercel whoami, gcloud auth list, eas whoami, firebase login:list), an API key or token another room uses (its .env or the macOS keychain: security find-generic-password -s <service>; ask the manager which room deploys or uploads there), and the other Chrome profiles (~/.tiny-hq/app/manager/profiles <site>). Use one if it works. If none does, name what you checked in --tried, e.g. --tried "wrangler whoami: not signed in; manager/profiles cloudflare: none; no Cloudflare token in other rooms".';
export function loginsUnchecked(why: string, tried: string, text: string): string | undefined {
  if (why !== 'password' && !(why === 'hands' && SIGN_IN.test(text))) return undefined;
  if (LOGINS_CHECKED.test(tried)) return undefined;
  return `--tried doesn't say which existing logins you checked. ${LOGIN_PLACES}`;
}

// undefined: fine. Otherwise the message to print, and the button is refused. `text` is the
// button's question and its options joined by " | ", for the checks that read what is asked.
export function checkOnlyOwner(why: string | undefined, tried: string | undefined, text = ''): string | undefined {
  const w = (why ?? '').trim().toLowerCase();
  if (w === 'send' || w === 'email') return NO_SEND_BUTTON;
  const merge = mergeButton(w, text);
  if (merge) return merge;
  if (!(w in REASONS)) return `${why ? `"${why}" is not something only the owner can do.` : 'Missing --why.'}\n${ONLY_OWNER_HELP}`;
  if (cleanLine(tried ?? '', 400).length < MIN_TRIED) return `Missing --tried: say what you already did or tried yourself before asking the owner.\n${ONLY_OWNER_HELP}`;
  return loginsUnchecked(w, tried ?? '', text);
}
