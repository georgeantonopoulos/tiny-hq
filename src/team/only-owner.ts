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
  hands: 'a step only their hands can do, such as a switch in macOS System Settings (list the exact steps; their button reads Done, I did it / Stuck)',
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

// undefined: fine. Otherwise the message to print, and the button is refused.
export function checkOnlyOwner(why: string | undefined, tried: string | undefined): string | undefined {
  const w = (why ?? '').trim().toLowerCase();
  if (w === 'send' || w === 'email') return NO_SEND_BUTTON;
  if (!(w in REASONS)) return `${why ? `"${why}" is not something only the owner can do.` : 'Missing --why.'}\n${ONLY_OWNER_HELP}`;
  if (cleanLine(tried ?? '', 400).length < MIN_TRIED) return `Missing --tried: say what you already did or tried yourself before asking the owner.\n${ONLY_OWNER_HELP}`;
  return undefined;
}
