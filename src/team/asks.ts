// Asks: a session that needs the owner's yes (The manager, or a room) puts the question on
// the floor with manager/ask, in ~/.tiny-hq/manager/asks.json. The owner sees an
// Approve / No button over that person's head, oldest question first; their click
// is typed into that session's own chat by the office, as their answer. A session
// can have several questions open; asking the same thing again just refreshes it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normTarget } from './posts.ts';

export interface Ask {
  id: string; // random, short
  folder: string; // where the asking session works (real path)
  sessionId?: string; // the asking session itself, so the answer reaches it and not another session in the same folder
  question: string; // one line the owner reads on the button
  createdAt: number;
  job?: string; // raised by `job wait`: Approve puts that job back to work
  options?: string[]; // a multiple-choice question: the owner picks one of these (no Approve / No)
  forJob?: string; // the room's own question, which a waiting job rides on: any answer from the owner puts that job back to work
  trust?: { name: string; task: string }; // "Trust and start": Claude Code doesn't trust this folder; Approve trusts it and starts `name`'s session with `task` (manager/delegate)
  why?: string; // why only the owner can do it (src/team/only-owner.ts)
  tried?: string; // what the asker already tried, shown to the owner under the question
  askedFor?: true; // put over this room by someone else (The manager's `ask --room`): never the room's own question; the owner's answer goes into the room's chat as their own click (roomLine) and a copy to the session that asked
  post?: string; // --why post: the exact text the owner approves; their Approve gives a one-time pass for it
  target?: string; // --why post: where it goes (owner/repo#N, owner/repo, or a page URL); the pass is only for there
}

export const MAX_OPTIONS = 6;
// 2 to 6 short, distinct answers; anything else means a plain yes/no question.
export function validOptions(o: unknown): string[] | undefined {
  if (!Array.isArray(o)) return undefined;
  const seen = new Set<string>();
  const out = o.filter((x): x is string => typeof x === 'string').map((x) => clean(x, 80)).filter((x) => x && !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase()));
  return out.length >= 2 && out.length <= MAX_OPTIONS ? out : undefined;
}

function validTrust(t: unknown): { name: string; task: string } | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const o = t as Record<string, unknown>;
  const name = typeof o.name === 'string' ? clean(o.name, 100) : '';
  // The task keeps its line breaks: it is handed to the new session as written.
  const task = typeof o.task === 'string' ? o.task.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, 20_000) : '';
  return name && task ? { name, task } : undefined;
}

const clean = (s: string, n: number) => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function validAsk(a: unknown): Ask | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const o = a as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[a-z0-9]{6,16}$/.test(o.id)) return undefined;
  if (typeof o.folder !== 'string' || !o.folder.startsWith('/')) return undefined;
  const question = typeof o.question === 'string' ? clean(o.question, 200) : '';
  if (!question) return undefined;
  return {
    id: o.id,
    folder: o.folder,
    question,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    ...(typeof o.sessionId === 'string' && /^[0-9a-f-]{36}$/.test(o.sessionId) ? { sessionId: o.sessionId } : {}),
    ...(typeof o.job === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(o.job) ? { job: o.job } : {}),
    ...(validOptions(o.options) && !(typeof o.job === 'string') ? { options: validOptions(o.options) } : {}),
    ...(typeof o.forJob === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(o.forJob) && typeof o.job !== 'string' && (o.askedFor !== true || !!o.trust) ? { forJob: o.forJob } : {}),
    ...(typeof o.why === 'string' && clean(o.why, 20) ? { why: clean(o.why, 20) } : {}),
    ...(typeof o.tried === 'string' && clean(o.tried, 400) ? { tried: clean(o.tried, 400) } : {}),
    // A post's exact text (button-only posts): kept as written, line breaks included.
    ...(typeof o.post === 'string' && o.why === 'post' && o.post.trim() ? { post: o.post.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 5000) } : {}),
    ...(typeof o.target === 'string' && o.why === 'post' && normTarget(o.target) ? { target: normTarget(o.target) } : {}),
    ...(o.askedFor === true && typeof o.sessionId === 'string' ? { askedFor: true as const } : {}),
    ...(validTrust(o.trust) && typeof o.job !== 'string' && !validOptions(o.options) ? { trust: validTrust(o.trust) } : {}),
  };
}

// One question per room about a job. When `job wait` (or Bring back) wants an Approve
// button where the room already has its own question up for the owner, the job rides on
// that question instead: the owner saw two buttons per room, and answering one left the other.
// The room's own question may come from one of its worktrees (a room asking from
// <project>/.claude/worktrees/<branch> used to get a second button per job). Each own question carries at most one job; a job takes the free one that reads
// most like it (same PR number, same words), else the oldest free one, else keeps its own button.
export const roomOf = (folder: string): string => folder.replace(/\/\.claude\/worktrees\/.*$/, '');
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g)?.filter((w) => w.length > 3 || /\d/.test(w)) ?? []);
const likeness = (a: string, b: string) => {
  const wb = words(b);
  return [...words(a)].reduce((n, w) => n + (wb.has(w) ? (/\d/.test(w) ? 3 : 1) : 0), 0);
};
export function oneQuestionPerJob(asks: Ask[]): Ask[] {
  const byAge = [...asks].sort((x, y) => x.createdAt - y.createdAt);
  // (A question someone else put over the room, like the manager's next move, is not the room's own.)
  // A pending "Trust and start" button carries the room's job too (otherwise job wait put a second
  // "tap Trust and start" button over the same room): the owner's tap starts the room with its task.
  const own = byAge.filter((a) => !a.job && (!a.askedFor || !!a.trust));
  const ride = new Map<string, string>(); // room's ask id -> job id
  for (const a of own) if (a.forJob) ride.set(a.id, a.forJob);
  const carried = new Set(ride.values());
  const pairs: { own: Ask; job: Ask; score: number }[] = [];
  for (const j of byAge) {
    if (!j.job || carried.has(j.job)) continue;
    // A post's Approve carries its pass: it rides only on the room's own button for the very same post.
    for (const o of own) if (!ride.has(o.id) && roomOf(o.folder) === roomOf(j.folder) && (!j.post || (o.post === j.post && o.target === j.target))) pairs.push({ own: o, job: j, score: likeness(o.question, j.question) });
  }
  pairs.sort((x, y) => y.score - x.score || x.job.createdAt - y.job.createdAt || x.own.createdAt - y.own.createdAt);
  for (const p of pairs) if (!ride.has(p.own.id) && !carried.has(p.job.job!)) (ride.set(p.own.id, p.job.job!), carried.add(p.job.job!));
  return asks.filter((a) => !(a.job && carried.has(a.job))).map((a) => (ride.has(a.id) && a.forJob !== ride.get(a.id) ? { ...a, forJob: ride.get(a.id) } : a));
}

export function loadAsks(path: string): Ask[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { asks?: unknown };
    return oneQuestionPerJob((Array.isArray(raw.asks) ? raw.asks : []).map(validAsk).filter((a): a is Ask => !!a).slice(0, 50));
  } catch {
    return [];
  }
}

export function saveAsks(path: string, asks: Ask[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ asks }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function asksPath(managerNotesDir: string): string {
  return `${managerNotesDir}/asks.json`;
}

export const MAX_ASKS_PER_FOLDER = 5;

// A new ask joins the folder's open ones. Only the same question again (or a new
// `job wait` for the same job) replaces its older copy; past five the oldest goes.
// (It used to replace every ask from the folder: the second question wiped the first.)
export function addAsk(asks: Ask[], folder: string, question: string, now = Date.now(), id = Math.random().toString(36).slice(2, 10), sessionId?: string, job?: string, options?: string[], askedFor = false, trust?: { name: string; task: string }, proof?: { why: string; tried: string; post?: string; target?: string }): Ask[] {
  const a = validAsk({ id: id.padEnd(6, '0'), folder, question, createdAt: now, sessionId, job, options, ...(askedFor ? { askedFor: true } : {}), ...(trust ? { trust } : {}), ...(proof ?? {}) });
  if (!a) return asks;
  const same = (x: Ask) => x.folder === folder && (x.question === a.question || (!!a.job && x.job === a.job));
  const mine = [...asks.filter((x) => x.folder === folder && !same(x)), a].slice(-MAX_ASKS_PER_FOLDER);
  return oneQuestionPerJob([...asks.filter((x) => x.folder !== folder), ...mine]);
}

// The asks to show: per folder the oldest still open (the rest wait their turn), and how many wait.
// The room's own questions come before ones someone else put over it (The manager's next move).
export function oldestPerFolder(asks: Ask[]): { ask: Ask; more: number }[] {
  const out = new Map<string, { ask: Ask; more: number }>();
  for (const a of [...asks].sort((x, y) => Number(!!x.askedFor) - Number(!!y.askedFor) || x.createdAt - y.createdAt)) {
    const cur = out.get(a.folder);
    if (cur) cur.more++;
    else out.set(a.folder, { ask: a, more: 0 });
  }
  return [...out.values()];
}

// The owner's answer: yes / no, or which of the options they picked. On a password / sign-in button
// (--why password) the buttons mean something else (a room could take Approve on "Sign in to App
// Store Connect" as leave to type the password): yes is "Done, I did it myself", and signIn is their
// leave for the room to sign in itself with what's already saved (a passkey or password-manager autofill), for when they're away.
export type Answer = { yes: boolean } | { choice: number } | { signIn: true };
export const isPassword = (ask: Ask): boolean => ask.why?.toLowerCase() === 'password' && !ask.options && !ask.trust;

// What the office types for the owner's answer on a password / sign-in button.
function passwordLine(ask: Ask, answer: Answer, where: string): string | undefined {
  if ('signIn' in answer)
    return `The owner: sign in yourself: "${ask.question}". (They clicked "You sign in" ${where}: they may be away from the Mac.) You may use only what is already saved: a saved passkey or password-manager autofill in Chrome. Never read, copy, note or type the password itself, and never put it in a command, file or message. If it needs Touch ID, a phone, a 2-factor code or a password that isn't saved, stop, leave it, and tell the manager what it needs; don't put up another button for it.`;
  if (!('yes' in answer)) return undefined;
  return answer.yes
    ? `The owner: done, they did it themselves: "${ask.question}". (They clicked "Done, I did it" ${where}.) Check it took and carry on. Don't type, fill or look up any password yourself.`
    : `The owner: no: "${ask.question}". (They clicked No ${where}.) Don't sign in; find another way or tell the manager what you need.`;
}

// What the office types into the session when the owner clicks. Plain about where it came from.
// undefined: that answer doesn't fit the question (a choice on a yes/no one, or out of range).
// A question the manager put over a room (ask --room): the owner's answer also goes into that room's own
// chat, worded as their own click, so the room acts on it without asking them again (a relayed answer
// is rightly refused by the room, and the owner would have to click twice).
export function roomLine(ask: Ask, answer: Answer): string | undefined {
  if (!ask.askedFor || ask.trust) return undefined;
  if (isPassword(ask)) {
    const t = passwordLine(ask, answer, 'themselves on the button over your head in the office, put there by the manager; this is their own click typed into your chat by the office, not a relay');
    return t === undefined ? undefined : clean(t, 1400);
  }
  if ('signIn' in answer) return undefined;
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  ask = { ...ask, question: cut(ask.question, 400), ...(ask.options ? { options: ask.options.map((o) => cut(o, 60)) } : {}) };
  if (ask.options) {
    if (!('choice' in answer) || !ask.options[answer.choice]) return undefined;
    return clean(
      `The owner chose: "${ask.options[answer.choice]}". (They picked it themselves on the button over your head in the office. The manager put the question there for you: "${ask.question}"; the other options were ${ask.options.filter((_, i) => i !== answer.choice).map((o) => `"${o}"`).join(', ')}. This is the owner's own click typed into your chat by the office, not a relay: act on it now.)`,
      1400,
    );
  }
  if (!('yes' in answer)) return undefined;
  return clean(
    answer.yes
      ? `The owner: yes, go ahead: "${ask.question}". (They clicked Approve themselves on the button over your head in the office, put there by the manager. This is the owner's own click typed into your chat by the office, not a relay: act on it now.)`
      : `The owner: no: "${ask.question}". (They clicked No themselves on the button over your head in the office, put there by the manager.) Don't do it; carry on with anything else you have.`,
    1000,
  );
}

// Worth starting a room's session for: a yes, or a pick that isn't "nothing / no / not now".
export function wantsAction(ask: Ask, answer: Answer): boolean {
  if ('signIn' in answer) return true;
  if ('yes' in answer) return answer.yes;
  const pick = (ask.options?.[answer.choice] ?? '').trim();
  return !!pick && !/^(nothing( now| for now)?|no|nope|not (now|yet)|skip( it)?|later|leave it|none|wait)[.!]?$/i.test(pick);
}

// Lines the office (or Claude Code) types into a session's chat: never the owner's own answer.
// Also Claude Code's own records of commands, shell output and Esc. Whiteboard clicks the office
// types into the manager's chat say so in the line ("on your whiteboard", "(They clicked …").
const OFFICE_LINE = /^\s*(<pasted_content|<task-notification|<cross-session-message|<system-reminder|<command-|<local-command|<bash-|\[Request interrupted|\[Office[: ]|\[Scheduled: |The owner: (yes|no|done|sign in)\b|The owner chose: |The owner: (action this|bring back|don't action|drop job)|The owner (set|cleared) the goal|Job [a-z0-9-]+: read )/;
const OFFICE_ANYWHERE = /on your whiteboard|\(They (clicked|picked|tapped|typed) /;

// What the owner typed into a session's chat after `since` (ms), from its transcript lines, if anything.
// Otherwise an owner who answers by chatting in the room leaves the button up, out of date.
export function typedSince(lines: string[], since: number): string | undefined {
  return typedLinesSince(lines, since)[0];
}

// Does a line the owner typed in the room's chat answer this question? (A chat line that only
// mentioned the project used to take down a merge button.) A short yes/no/wait, one of
// its choices, or the same #number or two of the question's own words. Otherwise the button stays:
// a stale button is better than a lost one.
const ANSWER_WORD = /^\W*(yes|yep|yeah|yup|ok|okay|sure|go( ahead)?|do it|approved?|approve it|confirmed?|no|nope|don'?t|not (yet|now)|wait|later|hold|merge( it)?|ship it|send it|post it|skip( it)?|leave it|cancel)\b/i;
const keyWords = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) ?? []).filter((w) => !['about', 'there', 'which', 'would', 'could', 'should', 'their', 'these', 'those', 'please'].includes(w)));
export function answersAsk(said: string, ask: Ask): boolean {
  // What the owner wrote themselves: not a pasted block or an office line that came in with it (a short
  // reply plus a pasted job report used to share words with the merge question and take its button down).
  const t = said.replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, ' ').replace(/^\s*\[Office[^\n]*$/gm, ' ').trim();
  if (!t) return false;
  if (ANSWER_WORD.test(t)) return true;
  const low = t.toLowerCase();
  if ((ask.options ?? []).some((o) => low.includes(o.toLowerCase()))) return true;
  const nums = new Set([...ask.question.matchAll(/#(\d+)/g)].map((m) => m[1]));
  if ([...t.matchAll(/#(\d+)/g)].some((m) => nums.has(m[1]))) return true;
  if (t.length > 400) return false; // a long message is about something else, not a reply to a button
  const mine = keyWords(ask.question);
  return [...keyWords(t)].filter((w) => mine.has(w)).length >= 2;
}

export function typedLinesSince(lines: string[], since: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.includes('"user"')) continue;
    let d: { type?: string; isMeta?: boolean; isSidechain?: boolean; timestamp?: string; origin?: { kind?: string }; message?: { content?: unknown } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'user' || d.isMeta || d.isSidechain || !(Date.parse(d.timestamp ?? '') > since)) continue;
    if (d.origin?.kind && d.origin.kind !== 'human') continue; // task notifications and the like
    const c = d.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && (x as { type?: string }).type === 'text').map((x) => (x as { text?: string }).text ?? '').join('') : '';
    if (text.trim() && !OFFICE_LINE.test(text) && !OFFICE_ANYWHERE.test(text)) out.push(text.trim());
  }
  return out;
}

// The room's own open question (not one someone else put over it), in its folder or one of its
// worktrees. The manager's ask --room is refused while one is up: two buttons asking the owner the same thing
// would otherwise be up at once.
export function roomsOwnQuestion(asks: Ask[], room: string): Ask | undefined {
  return asks.find((a) => !a.askedFor && !a.trust && (a.folder === room || a.folder.startsWith(`${room}/.claude/worktrees/`)));
}

// What `ask cancel` takes down: this folder's questions, plus every question this session put up
// anywhere (The manager's --room ones are filed under the room's folder, not theirs). With --room, only the
// asker's own questions over that room; the room's own stay.
// `id`: just that one question (and only if it is this folder's or this session's).
// A bare cancel used to take every question the session had put up anywhere; now it takes this
// folder's questions from this session (or with no session), and those it put over rooms from the manager's folder.
export function afterCancel(asks: Ask[], folder: string, me: string | undefined, room: boolean, id?: string, manager = false): Ask[] {
  // The manager runs the jobs, so it may take down any job's button by its id (job wait has no session).
  const mine = (a: Ask) => a.folder === folder || (!!me && a.sessionId === me) || (manager && !!a.job);
  if (id) return asks.filter((a) => !(a.id === id && mine(a)));
  if (room) return asks.filter((a) => !(a.folder === folder && a.askedFor && a.sessionId === me));
  return asks.filter((a) => !((a.folder === folder && (!me || !a.sessionId || a.sessionId === me)) || (!!me && a.sessionId === me && a.askedFor)));
}

export function answerLine(ask: Ask, answer: Answer | boolean): string | undefined {
  const a: Answer = typeof answer === 'boolean' ? { yes: answer } : answer;
  if (ask.post && 'yes' in a) {
    // The text the pass is for (--text), not the question's wording; a long one is named, not cut mid-way.
    const said = ask.post.length <= 300 ? `"${ask.post}"` : `"${ask.post.slice(0, 200)}…" (the full --text you gave, ${ask.post.length} characters)`;
    return clean(
      a.yes
        ? `The owner: yes, post exactly this: ${said}${ask.target ? ` on ${ask.target}` : ''}. (They clicked Approve on the button over your head in the office, on this exact text; your question was: "${ask.question}".) The office gave you a one-time pass for it, good for 2 hours${ask.target ? `, only on ${ask.target}` : ''}: post it once, exactly as approved (same words), on its own; anything else is still refused.`
        : `The owner: no, don't post it: ${said}. (They clicked No on the button over your head.) Nothing goes up; tell the manager if something else should.`,
      900,
    );
  }
  if (isPassword(ask)) {
    const t = passwordLine(ask, a, `on the button over your head in the office${ask.job ? ` for job ${ask.job}` : ''}`);
    return t === undefined ? undefined : clean(t, 1200);
  }
  if ('signIn' in a) return undefined;
  if (ask.options) {
    if (!('choice' in a) || !Number.isInteger(a.choice) || !ask.options[a.choice]) return undefined;
    return clean(`The owner chose: "${ask.options[a.choice]}". (They picked it on the button over your head in the office, for your question: "${ask.question}"; the other options were ${ask.options.filter((_, i) => i !== a.choice).map((o) => `"${o}"`).join(', ')}.)`, 900);
  }
  if (!('yes' in a)) return undefined;
  const yes = a.yes;
  if (ask.trust)
    return clean(
      yes
        ? `The owner: yes, trust it. (They tapped Approve on "${ask.question}".) The office has marked ${ask.folder} trusted for Claude Code and started ${ask.trust.name}'s session there with your task; wait for its report.`
        : `The owner: no, don't trust ${ask.folder}. (They tapped No on "${ask.question}".) No session was started there; find another way or drop that task.`,
      700,
    );
  if (ask.job)
    return clean(
      yes
        ? `The owner: yes, go ahead and do it yourself now: "${ask.question}". (They clicked Approve over your head in the office for job ${ask.job}; the job is active again.) Then carry on with the job. If a tool still refuses even with their yes, tell the manager exactly what refused and the command.`
        : `The owner: no, not that. (They clicked No over your head in the office for job ${ask.job}: "${ask.question}") Find another way to finish the job, or tell the manager what you need instead.`,
      700,
    );
  return clean(
    yes
      ? `The owner: yes, go ahead. (They clicked Approve on the button over your head in the office, for your question: "${ask.question}")`
      : `The owner: no, don't do that. (They clicked No on the button over your head in the office, for your question: "${ask.question}") Carry on with anything else, or tell the manager what you need instead.`,
    600,
  );
}

// The waiting job the owner's answer puts back to work: a job's own button only on Approve; the
// room's own question a job rides on, on any answer (they answered what the room was waiting for).
export function jobAnswered(ask: Ask, answer: Answer): string | undefined {
  if (ask.job) return ('yes' in answer && answer.yes) || 'signIn' in answer ? ask.job : undefined;
  return ask.forJob;
}
