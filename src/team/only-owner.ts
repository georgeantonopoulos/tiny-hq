// Only the owner: the short list of things a session may hand to the owner, and the
// check every button for them goes through (manager/ask, manager/job wait). A button
// must say why only the owner can do it (one of the reasons below) and what the
// asker already tried. Everything else, a room or the manager does itself; a broken
// office tool goes to the manager as an office fault, not to the owner.
// (Without it, most of what reaches the owner isn't theirs to do.)

export const REASONS = {
  send: 'send an email they must approve (a room drafts it first)',
  post: 'put exact text on a public site (posts, comments, replies, reviews, DMs, uploads)',
  pay: 'pay or commit money',
  irreversible: 'a step that cannot be undone (deleting data or an account, a release that cannot be pulled back): say what would be lost',
  choice: "the manager only: an office-wide decision that is the owner's (give your recommendation). A room decides every other choice itself and writes it in the evening note",
  permission: 'approve one exact command or tool their settings refuse (name it)',
  hands: 'a step only their hands can do, such as a switch in macOS System Settings (list the exact steps; their button reads Done, I did it / Stuck)',
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

// Fewer questions for the owner: a room raises a button only when it is blocked on money, public
// text or something that can't be undone (plus what only their hands, password or settings can do).
// Every other choice the room makes itself and tells them in the evening note (src/team/evening.ts).
// `choice` stays for the manager's few office-wide questions.
export const ROOM_DECIDES =
  'No button: a room makes this choice itself (buttons are only for money, public text or something that can\'t be undone). Pick what you would recommend, carry on, and tell the owner in tonight\'s evening note: ~/.tiny-hq/app/manager/evening add "<what you decided, and why>".';

// undefined: fine. Otherwise the message to print, and the button is refused.
// `manager`: the asker is the manager's own session (the only one that may still ask a plain choice).
export function checkOnlyOwner(why: string | undefined, tried: string | undefined, manager = false): string | undefined {
  const w = (why ?? '').trim().toLowerCase();
  if (!(w in REASONS)) return `${why ? `"${why}" is not something only the owner can do.` : 'Missing --why.'}\n${ONLY_OWNER_HELP}`;
  if (w === 'choice' && !manager) return ROOM_DECIDES;
  if (cleanLine(tried ?? '', 400).length < MIN_TRIED) return `Missing --tried: say what you already did or tried yourself before asking the owner.\n${ONLY_OWNER_HELP}`;
  return undefined;
}
