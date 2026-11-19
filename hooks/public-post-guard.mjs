#!/usr/bin/env node
// PreToolUse hook for every session (global, in ~/.claude/settings.json): nothing goes on a public
// site without the owner's yes for that exact text: one unapproved post can get the owner's account
// banned, and a quick click on a permission prompt is not a considered yes.
// So posts are button-only: a post is refused outright unless the owner approved that exact text on their
// button (manager/ask "<what and where>" --why post --tried "<...>" --text "<exact text>"), which leaves
// a one-time pass (hooks/post-approvals.mjs).
//
// What counts as posting (commands are read as shell words, so gh or
// curl is found wherever it sits, behind env vars, full paths, `command`, `bash -c '…'`, loops):
//   - gh commands that put text where other people read it: issue/PR comments and reviews, issue
//     create, issue/PR edits of title or body, closing or reopening with a comment, gists,
//     discussions, a public repo, alias set, any gh api write, a GraphQL mutation. The owner's own PRs
//     and releases are work, not posts: gh pr create and gh release create run as before. A gh
//     subcommand the guard doesn't know (an alias) counts as a post.
//   - curl/wget/http writes to a social site or to GitHub's API.
//   - a browser action (click, type, key, form fill, upload, script) in a tab this session opened on a
//     social or forum site, or in a tab it never opened. Looking (screenshots, reading) never stops.
// A post must be its own command, with its text written out plainly (no $, backticks or body files),
// so what the owner approved is exactly what goes up. Anything the guard can't read for certain is
// refused. It guards against accidents; a room set on getting round it on the owner's own account could.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normTarget } from './post-approvals.mjs';

const DEPLOY_HOW = (name, head = '<commit>') => `ask the owner first, from the project folder with everything committed: manager/ask "<what goes public and why>" --why post --tried "<what you checked>" --text "deploy ${name} at ${head} publicly" --target deploy:${name} --changes "<what a person will see or hear differently>" --proven "<what you saw or heard, on which device>". Their button lists the commits since the last approved deploy. Once they approve, deploy that exact commit on its own within 2 hours, then open its address logged out to check it shows what they approved.`;
const HOW = 'Put the exact text and where it goes to the owner first: manager/ask "<what and where>" --why post --tried "<what you did>" --text "<the exact text>" --target <owner/repo#number, owner/repo for a new issue, or the page URL>. Once they approve, run the post on its own, with exactly that text written out (-b "<text>"), on that PR or issue (its number, and -R owner/repo outside its own folder), within 2 hours.';

// ---- Shell words ----
// Enough of sh for this: quotes, backslashes, and the separators ; & | ( ) and newlines (as ";").
// Here-documents: the text after `<<EOF` up to the EOF line is data for the command, not
// commands, unless that command is a shell (bash <<EOF runs it). Rooms writing a file or a script
// that only mentions a deploy or a gh post used to be refused.
const HEREDOC_RUNS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'source', '.', 'ssh', 'xargs', 'env', 'sudo', 'exec', 'command', 'nohup', 'time', 'timeout']);
// `live`, when given, gets each word as the shell would expand it: the same length, with text it
// leaves alone (single-quoted, or after a backslash) blanked to "_", so a $( … ) or ` … ` found
// there is one the shell really runs (approved text often quotes `code` in single quotes).
// Where the ")" closing a $( … ) is, from just inside it: quotes, backslashes and nested $( … ) are
// skipped as the shell would. The end of the text when it never closes.
function subEnd(cmd, from) {
  let depth = 1;
  for (let j = from; j < cmd.length; j++) {
    const c = cmd[j];
    if (c === '\\') j++;
    else if (c === "'") { const e = cmd.indexOf("'", j + 1); if (e < 0) return cmd.length - 1; j = e; }
    else if (c === '"') {
      for (j++; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\') j++;
        else if (cmd[j] === '$' && cmd[j + 1] === '(') j = subEnd(cmd, j + 2);
      }
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return cmd.length - 1;
}
export function words(cmd, live) {
  const out = [];
  let cur = '', lv = '', q = null, any = false;
  const pending = []; // here-document ends waiting for the next newline: { end, tabs, keep }
  const push = (w, l = w) => { out.push(w); live?.push(l); };
  const flush = () => { if (cur || any) push(cur, lv); cur = ''; lv = ''; any = false; };
  // The program of the command being built: the first word after the last separator.
  const program = () => {
    let k = out.length;
    while (k > 0 && !SEP_CHARS.has(out[k - 1])) k--;
    const seg = out.slice(k).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    return basename(seg[0] ?? cur ?? '');
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (!q && ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      // <<[-] delimiter (quoted or not)
      flush();
      let j = i + 2;
      const tabs = cmd[j] === '-';
      if (tabs) j++;
      while (cmd[j] === ' ' || cmd[j] === '\t') j++;
      let end = '';
      let dq = null;
      for (; j < cmd.length; j++) {
        const c = cmd[j];
        if (dq) { if (c === dq) dq = null; else end += c; continue; }
        if (c === "'" || c === '"') { dq = c; continue; }
        if (c === '\\') continue;
        if (/[\s;&|()<>]/.test(c)) break;
        end += c;
      }
      if (end) {
        pending.push({ end, tabs, keep: HEREDOC_RUNS.has(program()) });
        i = j - 1;
        continue;
      }
    }
    if (!q && ch === '\n' && pending.length) {
      flush();
      push(';');
      // Skip (or keep, for a shell) each pending body up to its end line.
      let j = i + 1;
      for (const h of pending.splice(0)) {
        let body = '';
        for (;;) {
          const nl = cmd.indexOf('\n', j);
          const line = cmd.slice(j, nl < 0 ? cmd.length : nl);
          j = nl < 0 ? cmd.length : nl + 1;
          if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.end || nl < 0) {
            if ((h.tabs ? line.replace(/^\t+/, '') : line) !== h.end) body += line;
            break;
          }
          body += line + '\n';
        }
        if (h.keep) {
          const bl = [];
          words(body, bl).forEach((w, k) => push(w, bl[k]));
          push(';');
        }
      }
      i = j - 1;
      continue;
    }
    if (q === "'") { if (ch === "'") q = null; else { cur += ch; lv += '_'; } continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && i + 1 < cmd.length && '"\\$`\n'.includes(cmd[i + 1])) { cur += cmd[++i]; lv += '_'; }
      // A $( … ) inside double quotes is shell code with its own quoting: a quoted ")" in it doesn't
      // close it, and its quotes don't end the outer ones (review: echo "$(echo ")" ; gh pr comment …)"
      // hid the post). It's kept whole, so substitutions() reads it.
      else if (ch === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') { const e = subEnd(cmd, i + 2); cur += cmd.slice(i, e + 1); lv += cmd.slice(i, e + 1); i = e; }
      // The shell doesn't glob or expand braces inside double quotes: only $ and backticks stay live.
      else { cur += ch; lv += '*?[{~'.includes(ch) ? '_' : ch; }
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; any = true; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { if (cmd[i + 1] !== '\n') { cur += cmd[i + 1]; lv += '_'; } i++; any = true; continue; }
    if (ch === '\n') { flush(); push(';'); continue; }
    // A comment, as the shell reads it (a # starting a word): the rest of the line never runs, so it
    // is never read (e.g. "gh pr comment 44 -b x # -R a/b" showed the guard a/b).
    if (ch === '#' && !cur && !any) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if (';&|()<>'.includes(ch)) { flush(); push(ch); continue; }
    cur += ch; lv += ch; any = true;
  }
  flush();
  return out;
}
const SEP = new Set([';', '&', '|', '(', ')', '<', '>']);
const SEP_CHARS = SEP;

// Commands inside commands: the strings given to bash -c, sh -c, eval, xargs, env, and words that
// themselves look like a command line, are read too.
function segments(cmd, depth = 0) {
  const lw = [];
  const w = words(String(cmd ?? ''), lw);
  const segs = [[]];
  const lsegs = [[]]; // each word's live form (see words), alongside
  w.forEach((t, k) => {
    if (SEP.has(t)) { if (segs[segs.length - 1].length) { segs.push([]); lsegs.push([]); } return; }
    segs[segs.length - 1].push(t);
    lsegs[lsegs.length - 1].push(lw[k]);
  });
  const liveOf = new Map(segs.map((s, k) => [s, lsegs[k]]));
  const out = segs.filter((s) => s.length);
  // Only text that will be run: after -c (bash -c, sh -lc), or given to eval, xargs, watch and the
  // like. A commit message or grep that merely mentions "gh pr comment" isn't a post.
  const RUNS = new Set(['eval', 'xargs', 'watch', 'nohup', 'time', 'sudo', 'env', 'command', 'exec', 'parallel']);
  if (depth < 3) for (const s of [...out]) s.forEach((t, j) => {
    const runner = /^-[a-z]*c$/.test(s[j - 1] ?? '') || RUNS.has(basename(s[0]));
    if (runner && /\s/.test(t) && /\b(gh|curl|wget|xh|http|vercel|netlify|gh-pages|firebase|surge|wrangler|fly|flyctl|git)\b/.test(t)) out.push(...segments(t, depth + 1));
    // $( … ) and ` … ` are run wherever they sit, quoted words included ("$(gh pr comment …)").
    // Only where the shell expands them: not inside single quotes or after a backslash.
    for (const inner of substitutions(t, liveOf.get(s)?.[j] ?? t)) out.push(...segments(inner, depth + 1));
  });
  return out;
}

// The command text inside each $( … ) and ` … ` in a word (balanced parentheses; an unclosed one
// runs to the end of the word, which is read anyway).
// `live`: the word as words() saw the shell expand it (same length, quoted text blanked).
export function substitutions(t, live = t) {
  const out = [];
  const L = live.length === t.length ? live : t;
  for (let i = 0; i < t.length; i++) {
    if (L[i] === '$' && L[i + 1] === '(' && L[i + 2] !== '(') {
      let depth = 0, k = i + 1;
      for (; k < t.length; k++) {
        // A quoted ")" inside doesn't close it (review: "$(echo ')' ; gh pr comment …)" hid the post).
        // An unclosed quote runs on, which only reads more.
        if (L[k] === "'" || L[k] === '"') { const e = t.indexOf(L[k], k + 1); if (e < 0) { k = t.length; break; } k = e; }
        else if (L[k] === '(') depth++;
        else if (L[k] === ')' && --depth === 0) break;
      }
      out.push(t.slice(i + 2, k));
      i = k;
    } else if (L[i] === '`') {
      const k = L.indexOf('`', i + 1);
      out.push(t.slice(i + 1, k < 0 ? t.length : k));
      i = k < 0 ? t.length : k;
    }
  }
  return out;
}

// Where a program actually runs in a segment: the first word after any VAR=value assignments, shell
// keywords (do, then, if, !, …) and wrappers that run the rest (sudo, env, xargs, nohup, time, …),
// skipping those wrappers' own options. An argument such as the pattern in `rg gh src` is not a program.
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'time']);
const WRAPPERS = new Set(['sudo', 'env', 'xargs', 'nohup', 'time', 'command', 'exec', 'watch', 'parallel', 'nice', 'timeout', 'caffeinate', 'npx', 'bunx']);
export function programAt(seg) {
  const at = [];
  let k = 0;
  while (k < seg.length) {
    const t = seg[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || KEYWORDS.has(t)) { k++; continue; }
    at.push(k);
    if (!WRAPPERS.has(basename(t))) break;
    k++;
    // The wrapper's own options and their values (sudo -u x, xargs -n 1, timeout 10), up to the program.
    while (k < seg.length && (seg[k].startsWith('-') || /^\d+[smhd]?$/.test(seg[k]) || (/^-[unIPLs]$/.test(seg[k - 1] ?? '') && !seg[k].startsWith('-')))) k++;
  }
  return at;
}

// ---- What a segment does ----
const GH_KNOWN = new Set(['auth', 'browse', 'status', 'search', 'run', 'workflow', 'repo', 'pr', 'issue', 'release', 'label', 'cache', 'codespace', 'config', 'extension', 'gpg-key', 'ssh-key', 'secret', 'variable', 'ruleset', 'attestation', 'org', 'completion', 'help', 'version', 'api', 'gist', 'alias', 'project', 'discussion', 'agent-task', 'copilot', 'preview']);
const GH_TAKES_VALUE = new Set(['-R', '--repo', '--hostname']);
const TEXT_FLAGS = ['-b', '--body', '-t', '--title', '-F', '--body-file', '-c', '--comment', '-e', '--editor', '-w', '--web'];

const isGh = (t) => basename(t) === 'gh';
const isCurl = (t) => ['curl', 'wget', 'xh', 'http', 'https'].includes(basename(t));

// The gh words after the program: [subcommand, verb, ...rest], skipping global flags.
function ghArgs(seg, i) {
  const rest = seg.slice(i + 1);
  const out = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (out.length < 1 && GH_TAKES_VALUE.has(a)) { k++; continue; }
    if (out.length < 1 && /^(-R|--repo|--hostname)=/.test(a)) continue;
    out.push(a);
  }
  return out;
}
const hasFlag = (args, names) => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`) || (/^-[a-zA-Z]$/.test(n) && a.startsWith(n) && a.length > 2 && !a.startsWith('--'))));

// gh takes the last --visibility; any "public" among several counts as public.
const visibilityTo = (args) => {
  const seen = [];
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--visibility') seen.push(String(args[k + 1] ?? '').toLowerCase());
    else if (args[k].startsWith('--visibility=')) seen.push(args[k].slice(13).toLowerCase());
  }
  return seen.includes('public') ? 'public' : seen.at(-1) ?? '';
};

// Is this gh call a post? Returns a short description, or undefined.
function ghPost(args) {
  // The verb is the first plain word after the subcommand, skipping -R/--repo and its value
  // (gh pr -R o/r comment 5 is still a comment).
  const sub = args[0];
  let verb;
  for (let k = 1; k < args.length; k++) {
    if (GH_TAKES_VALUE.has(args[k])) { k++; continue; }
    if (!args[k].startsWith('-')) { verb = args[k]; break; }
  }
  if (!sub || sub.startsWith('-')) return undefined; // gh --version and the like
  if (!GH_KNOWN.has(sub)) return `the gh command "${sub}" (an alias or an unknown command could post)`;
  if ((sub === 'pr' || sub === 'issue') && (verb === 'comment' || verb === 'review')) return `a GitHub ${sub === 'pr' ? 'pull request' : 'issue'} ${verb}`;
  if (sub === 'issue' && verb === 'create') return 'a new GitHub issue';
  if ((sub === 'pr' || sub === 'issue') && verb === 'edit' && hasFlag(args, ['-b', '--body', '-t', '--title', '-F', '--body-file'])) return `an edit to a ${sub === 'pr' ? 'pull request' : 'issue'}'s title or text`;
  if ((sub === 'pr' || sub === 'issue') && (verb === 'close' || verb === 'reopen') && hasFlag(args, ['-c', '--comment'])) return `closing or reopening with a comment`;
  if (sub === 'gist' && ['create', 'edit', 'new'].includes(verb)) return 'a gist';
  if (sub === 'discussion') return 'a GitHub discussion';
  if (sub === 'alias' && ['set', 'import'].includes(verb)) return 'a gh alias (it could hide a post)';
  if (sub === 'repo' && verb === 'create' && hasFlag(args, ['--public'])) return 'a public repository';
  if (sub === 'repo' && verb === 'edit' && hasFlag(args, ['--visibility'])) return visibilityTo(args) === 'public' ? 'making a repository public' : undefined;
  if (sub === 'api') {
    const method = (() => { for (let k = 0; k < args.length; k++) { const a = args[k]; if (a === '-X' || a === '--method') return (args[k + 1] ?? '').toUpperCase(); if (/^(-X|--method=)/.test(a)) return a.replace(/^(-X|--method=)/, '').toUpperCase(); } return ''; })();
    const fields = hasFlag(args, ['-f', '-F', '--field', '--raw-field', '--input']);
    const endpoint = args.slice(1).find((a) => !a.startsWith('-') && !/^(GET|POST|PATCH|PUT|DELETE)$/i.test(a)) ?? '';
    if (endpoint === 'graphql') {
      const q = args.find((a) => /^query=/.test(a));
      if (!q || /^query=@/.test(q) || hasFlag(args, ['--input']) || /mutation/i.test(q)) return 'a GitHub GraphQL call that may change something';
      return undefined;
    }
    if (method === 'GET') return undefined;
    if (method || fields) return 'a GitHub API write (a read with fields needs --method GET)';
  }
  return undefined;
}

export const SOCIAL = [
  'reddit.com', 'redd.it', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'threads.net', 'threads.com',
  'linkedin.com', 'bsky.app', 'mastodon.social', 'tiktok.com', 'youtube.com', 'discord.com', 'news.ycombinator.com',
  'producthunt.com', 'medium.com', 'quora.com', 'stackoverflow.com', 'stackexchange.com', 'github.com', 'gitlab.com',
  'dev.to', 'hashnode.com', 'substack.com', 'tumblr.com', 'pinterest.com', 'vimeo.com', 'patreon.com', 'gumroad.com',
];
const hostOf = (u) => {
  try {
    return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const onList = (host, list) => !!host && list.some((d) => host === d || host.endsWith(`.${d}`));
const onSocial = (url) => onList(hostOf(url), SOCIAL);
// curl writes count on social sites and on code hosts' APIs; uploads.github.com (release files) is work.
const CURL_POST_HOSTS = [...SOCIAL, 'api.github.com', 'gitlab.com'];

function curlPost(seg, i) {
  const args = seg.slice(i + 1);
  const write = args.some((a, k) => /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-T|--upload-file)/.test(a) || ((a === '-X' || a === '--request') && /^(POST|PUT|PATCH|DELETE)$/i.test(args[k + 1] ?? '')) || /^(-X|--request=)(POST|PUT|PATCH|DELETE)$/i.test(a));
  const wgetWrite = basename(seg[i]) === 'wget' && args.some((a) => /^--(post|method|body)/.test(a));
  const httpie = ['http', 'https', 'xh'].includes(basename(seg[i])) && args.some((a) => /^(POST|PUT|PATCH|DELETE)$/.test(a) || /[^=]=[^=]|:=/.test(a));
  if (!write && !wgetWrite && !httpie) return undefined;
  const hosts = args.filter((a) => /^[a-z]+:\/\//i.test(a) || /^([a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(a)).map(hostOf);
  return hosts.some((h) => h !== 'uploads.github.com' && onList(h, CURL_POST_HOSTS)) ? 'sending data to a public site or GitHub' : undefined;
}

// Every post in a command: [{ why, seg, at }]. Segments where gh/curl sits behind env vars, a path,
// `command`, `sudo`, `xargs` or a loop keyword are all read.
function posts(cmd) {
  const out = [];
  for (const seg of segments(cmd)) {
    programAt(seg).forEach((i) => {
      const t = seg[i];
      if (isGh(t)) {
        const why = ghPost(ghArgs(seg, i));
        if (why) out.push({ why, seg, at: i });
      } else if (isCurl(t)) {
        const why = curlPost(seg, i);
        if (why) out.push({ why, seg, at: i });
      }
    });
  }
  return out;
}

export function postingCommand(cmd) {
  return posts(cmd)[0]?.why;
}

// The text a gh post puts up: its title (if any), a blank line, then its body. Undefined when it
// can't be read for certain: an editor, stdin, the web form, a GraphQL or API call without a
// literal body, or $ / backticks the shell would expand. Text in single quotes is literal, so a
// `code span` there is fine. A pr/issue
// --body-file is read here (a regular file, up to 1 MB); it must hold exactly the approved text.
const BODY_FILE_MAX = 1024 * 1024;
function readBodyFile(path, cwd) {
  try {
    const full = resolve(cwd, path);
    const st = statSync(full);
    if (!st.isFile() || st.size > BODY_FILE_MAX) return undefined;
    return readFileSync(full, 'utf8');
  } catch {
    return undefined;
  }
}
export function ghPostText(cmd, post = posts(cmd)[0], cwd = process.cwd()) {
  if (!post) return undefined;
  const live = [];
  const raw = words(String(cmd), live);
  // A here-document's text isn't in the words; read the command as it stands there.
  if (/<</.test(String(cmd)) ? /[`$]/.test(String(cmd)) : live.some((w) => /[`$]/.test(w))) return undefined;
  // Would the shell change this value before gh sees it: an unquoted *, ?, [ ], {a,b} or a leading ~
  // (review: -F [a]bc is read as "[a]bc" by us, but gh is handed the file abc)?
  const expanded = (v) => raw.some((w, k) => w.endsWith(v) && /[*?[]|\{[^}]*,|^~/.test(live[k].slice(w.length - v.length)));
  const args = post.seg.slice(post.at + 1);
  const sub = args.find((a, k) => !a.startsWith('-') && !GH_TAKES_VALUE.has(args[k - 1] ?? ''));
  const prOrIssue = sub === 'pr' || sub === 'issue';
  let title, body, bad = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const val = () => (a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : args[++k]);
    if (flag === '-b' || flag === '--body' || flag === '-c' || flag === '--comment') body = val();
    else if (flag === '-t' || flag === '--title') title = val();
    else if (/^-[bct].+/.test(a)) { if (a[1] === 't') title = a.slice(2); else body = a.slice(2); }
    else if (prOrIssue && (flag === '-F' || flag === '--body-file' || /^-F.+/.test(a))) {
      const v = /^-F.+/.test(a) ? a.slice(2) : val();
      const text = v && v !== '-' && !expanded(v) ? readBodyFile(v, cwd) : undefined;
      if (text === undefined) bad = true;
      else body = text;
    } else if (['-F', '--body-file', '-e', '--editor', '-w', '--web', '--input'].includes(flag) || /^-F.+/.test(a)) bad = true;
    else if (flag === '-f' || flag === '--field' || flag === '--raw-field') {
      const kv = val() ?? '';
      const key = kv.slice(0, kv.indexOf('='));
      if (key === 'body') body = kv.slice(kv.indexOf('=') + 1);
      else if (key === 'title') title = kv.slice(kv.indexOf('=') + 1);
      else if (/\bbody\b|comment|message|text|description/.test(key)) bad = true; // more public text than one body
    }
  }
  if (bad || [title, body].some((v) => v !== undefined && expanded(v))) return undefined;
  if (body === undefined) return title;
  return title !== undefined ? `${title}\n\n${body}` : body;
}

// Where a gh post goes (each pass is for one PR or issue): "owner/repo#N", "owner/repo" for a
// new issue, or undefined when it can't be told for certain (no number given, so gh would pick the
// current branch's PR). The repo comes from -R/--repo or GH_REPO, else the folder's GitHub remote.
const VALUE_FLAGS = new Set(['-b', '--body', '-t', '--title', '-c', '--comment', '-R', '--repo', '-F', '--body-file', '-l', '--label', '-a', '--assignee', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-B', '--base', '-H', '--head', '-f', '--field', '--raw-field', '-X', '--method', '-H', '--header', '-T', '--template', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project', '--hostname', '--jq', '-q']);
const API_VALUE_FLAGS = new Set(['-X', '--method', '-f', '-F', '--field', '--raw-field', '-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--cache', '--hostname', '--input']);
export function ghTarget(post, cwd, repoOf = remoteRepo) {
  if (post.seg.slice(0, post.at).some((w) => /^GH_HOST=/.test(w)) || otherHost() || hasFlag(post.seg.slice(post.at + 1), ['--hostname'])) return undefined;
  const seg = post.seg;
  const all = seg.slice(post.at + 1);
  let repo;
  for (let k = 0; k < all.length; k++) {
    if (VALUE_FLAGS.has(all[k]) && all[k] !== '-R' && all[k] !== '--repo') { k++; continue; } // a flag's value, e.g. a body of "-Rowner/x"
    if ((all[k] === '-R' || all[k] === '--repo') && all[k + 1]) repo = all[k + 1];
    else if (/^(-R|--repo=)/.test(all[k]) && all[k].length > 2) repo = all[k].replace(/^(-R|--repo=)/, '');
  }
  if (!repo) for (const w of seg.slice(0, post.at)) if (/^GH_REPO=/.test(w)) repo = w.slice(8);
  if (!repo && process.env.GH_REPO) repo = process.env.GH_REPO; // inherited, gh uses it over the folder's remote
  const own = () => (repo ? normTarget(repo).replace(/#.*/, '') : repoOf(cwd) ?? '');
  const args = ghArgs(seg, post.at);
  const sub = args[0];
  if (sub === 'api') {
    // The endpoint is the one plain word that isn't a flag's value; more than one is refused
    // (--jq's value is not the endpoint). Another host (--hostname, GH_HOST) is refused.
    const plain = [];
    for (let j = 1; j < args.length; j++) {
      const a = args[j];
      if (API_VALUE_FLAGS.has(a)) { j++; continue; }
      if (a.startsWith('-') || /^(GET|POST|PATCH|PUT|DELETE)$/i.test(a)) continue;
      plain.push(a);
    }
    if (plain.length !== 1 || hasFlag(args, ['--hostname']) || seg.slice(0, post.at).some((w) => /^GH_HOST=/.test(w))) return undefined;
    const endpoint = plain[0].replace(/^\/+/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^repos\/\{owner\}\/\{repo\}/, () => `repos/${own()}`);
    // Only a comment or review on one issue or PR, or a new issue: nothing else in a repo is covered
    // by a pass (an edit of an old comment, a commit comment, a new PR are refused).
    let m = endpoint.match(/^repos\/([A-Za-z0-9-]+\/[\w.-]+)\/(?:issues|pulls)\/(\d+)\/(?:comments|reviews)$/);
    if (m) return normTarget(`${m[1]}#${m[2]}`) || undefined;
    m = endpoint.match(/^repos\/([A-Za-z0-9-]+\/[\w.-]+)\/issues$/);
    return m ? normTarget(m[1]) || undefined : undefined;
  }
  if (sub !== 'pr' && sub !== 'issue') return undefined;
  let k = 1;
  for (; k < args.length; k++) { if (GH_TAKES_VALUE.has(args[k])) { k++; continue; } if (!args[k].startsWith('-')) break; }
  const verb = args[k];
  if (sub === 'issue' && verb === 'create') return own() || undefined;
  const nums = new Set();
  for (let j = k + 1; j < args.length; j++) {
    const a = args[j];
    if (VALUE_FLAGS.has(a)) { j++; continue; }
    if (a.startsWith('-')) continue;
    if (/^#?\d+$/.test(a)) nums.add(`${own()}#${Number(a.replace('#', ''))}`);
    else if (/github\.com\//i.test(a) && normTarget(a).includes('#')) nums.add(normTarget(a));
  }
  if (nums.size !== 1) return undefined;
  const t = normTarget([...nums][0]);
  return t.includes('#') && !t.startsWith('#') ? t : undefined;
}
// gh repo edit … --visibility public / gh repo create … --public: the repo going public ("owner/repo"),
// '' when it can't be told for certain, undefined when the command isn't one of these.
// GH_HOST inherited from the environment and pointing somewhere other than github.com.
const otherHost = () => !!process.env.GH_HOST && process.env.GH_HOST.toLowerCase() !== 'github.com';
export function repoGoingPublic(post, cwd, repoOf = remoteRepo) {
  const args = ghArgs(post.seg, post.at);
  if (args[0] !== 'repo') return undefined;
  let k = 1;
  for (; k < args.length; k++) { if (GH_TAKES_VALUE.has(args[k])) { k++; continue; } if (!args[k].startsWith('-')) break; }
  const verb = args[k];
  const isEdit = verb === 'edit' && visibilityTo(args) === 'public';
  const isCreate = verb === 'create' && hasFlag(args, ['--public']);
  if (!isEdit && !isCreate) return undefined;
  // Another GitHub host is refused: the pass is for one repo on github.com.
  const env = post.seg.slice(0, post.at);
  if (env.some((w) => /^GH_HOST=/.test(w)) || otherHost() || hasFlag(post.seg.slice(post.at + 1), ['--hostname'])) return '';
  const named = [];
  for (let j = k + 1; j < args.length; j++) {
    const a = args[j];
    if (['--visibility', '-d', '--description', '-h', '--homepage', '-t', '--team', '-g', '--gitignore', '-l', '--license', '-s', '--source', '-r', '--remote', '--add-topic', '--remove-topic', '--default-branch'].includes(a) || (isCreate && (a === '-p' || a === '--template'))) { j++; continue; }
    if (!a.startsWith('-')) named.push(a);
  }
  if (named.length > 1) return '';
  // The repo must be named in the command: with none, gh takes GH_REPO from wherever the shell got it
  // (a profile the guard can't see) over the folder's remote. A named repo is what gh uses.
  const t = named.length ? normTarget(named[0]) : '';
  return /^[a-z0-9-]+\/[\w.-]+$/.test(t) ? t : '';
}
// The folder's GitHub repo, as gh would pick it: the remote marked by `gh repo set-default`, else
// the only GitHub remote. Several GitHub remotes and no default (a fork with an upstream) is
// undefined: gh might pick another one, so the post must name its repo with -R.
function remoteRepo(cwd) {
  try {
    const out = execFileSync('git', ['-C', String(cwd ?? '.'), 'config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const urls = new Map();
    let chosen;
    for (const line of out.split('\n')) {
      const m = line.match(/^remote\.(.+)\.(url|gh-resolved) (.*)$/);
      if (!m) continue;
      if (m[2] === 'url') {
        const r = m[3].trim().match(/github\.com[:/]([A-Za-z0-9-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
        if (r) urls.set(m[1], r[1].toLowerCase());
      } else if (m[3].trim() === 'base') chosen = m[1];
      else if (m[3].trim().includes('/')) return normTarget(m[3].trim()) || undefined; // set-default to a named repo
    }
    if (chosen) return urls.get(chosen);
    return urls.size === 1 ? [...urls.values()][0] : undefined;
  } catch {
    return undefined;
  }
}

// ---- Deploys (button-only, like posts) ----
// A deploy anyone can open without a login is a public post: a first deploy can land on a public
// address even when the project was meant to stay private. Counted: vercel production
// deploys (--prod, promote, rollback, alias, or a first deploy from a folder not yet linked), every
// netlify deploy (drafts are public too), gh-pages, firebase deploy, surge, wrangler deploys and
// fly deploy. A vercel preview of a linked project stays allowed (Vercel protects previews).
// Approved as the fixed text "deploy <project> at <commit> publicly", for target deploy:<project>:
// one Approve per exact commit, nothing uncommitted.
const DEPLOY_TOOLS = new Set(['vercel', 'netlify', 'gh-pages', 'firebase', 'surge', 'wrangler', 'fly', 'flyctl']);
// Options these tools read a value for (`--token abc deploy`: "abc" is not the subcommand).
const DEPLOY_VALUE_FLAGS = new Set(['--token', '-t', '--scope', '-S', '--team', '-T', '--cwd', '--local-config', '-A', '--global-config', '-Q', '--meta', '-m', '--env', '-e', '--build-env', '-b', '--regions', '--archive', '--target', '--name', '-n', '--project', '-P', '--site', '-s', '--auth', '-a', '--app', '--dir', '-d', '--alias', '--config', '-c', '--only', '--message', '--branch', '--domain', '--functions', '--filter', '--context']);
function projectName(cwd) {
  const root = String(cwd ?? '').replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
  try {
    const p = JSON.parse(readFileSync(join(String(cwd ?? '.'), '.vercel', 'project.json'), 'utf8'));
    if (typeof p.projectName === 'string' && p.projectName) return p.projectName;
  } catch {
    /* not linked to vercel here */
  }
  return basename(root);
}
const vercelLinked = (cwd) => {
  try {
    readFileSync(join(String(cwd ?? '.'), '.vercel', 'project.json'));
    return true;
  } catch {
    return false;
  }
};
// The deploy in one command segment: { why, name } ('' name: can't tell which project), or undefined.
function deployAt(seg, i, cwd) {
  let k = i;
  let tool = basename(seg[k]);
  // pnpm dlx / yarn dlx / npm exec -- <tool>
  if (['pnpm', 'yarn', 'npm', 'bun'].includes(tool) && ['dlx', 'exec', 'x'].includes(seg[k + 1])) {
    k += 2;
    while (k < seg.length && seg[k].startsWith('-')) k++;
    tool = basename(seg[k] ?? '');
  }
  tool = tool.replace(/@.*$/, ''); // vercel@latest
  if (!DEPLOY_TOOLS.has(tool)) return undefined;
  const args = seg.slice(k + 1);
  const words = [];
  for (let j = 0; j < args.length; j++) {
    if (DEPLOY_VALUE_FLAGS.has(args[j])) { j++; continue; }
    if (!args[j].startsWith('-')) words.push(args[j]);
  }
  // The folder the deploy really runs in: --cwd, else the hook's folder.
  const cwdFlag = (() => {
    for (let j = 0; j < args.length; j++) {
      if (args[j] === '--cwd' && args[j + 1]) return args[j + 1];
      if (args[j].startsWith('--cwd=')) return args[j].slice(6);
    }
    return undefined;
  })();
  const here = cwdFlag ? resolve(String(cwd ?? '.'), cwdFlag.replace(/^~(?=\/|$)/, homedir())) : cwd;
  const flag = (...names) => args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
  // The folder a deploy uploads as it is, when the command names one: built output can change after
  // the owner's Approve without a commit, so it's checked below.
  const valueOf = (...names) => {
    for (let j = 0; j < args.length; j++) {
      if (names.includes(args[j]) && args[j + 1]) return args[j + 1];
      const m = names.map((n) => (args[j].startsWith(`${n}=`) ? args[j].slice(n.length + 1) : undefined)).find((v) => v !== undefined);
      if (m) return m;
    }
    return undefined;
  };
  const named = (() => {
    for (let j = 0; j < args.length; j++) {
      if (['--name', '--project', '-n', '--site', '-s'].includes(args[j]) && args[j + 1]) return args[j + 1];
      const m = /^--(name|project|site)=(.+)$/.exec(args[j]);
      if (m) return m[2];
    }
    return undefined;
  })();
  const name = String(named ?? projectName(here)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 100);
  if (tool === 'vercel') {
    const sub = words[0];
    const READS = new Set(['ls', 'list', 'inspect', 'logs', 'env', 'pull', 'link', 'login', 'logout', 'whoami', 'project', 'projects', 'domains', 'dns', 'certs', 'secrets', 'teams', 'switch', 'help', 'dev', 'build', 'init', 'git', 'integration', 'bisect', 'telemetry', 'remove', 'rm']);
    if (sub && READS.has(sub)) return undefined;
    // `vercel api <endpoint>`: a read passes; a change (a method other than GET, or a body) is a change
    // to the project's settings the owner approves in their own words for target deploy:<project> (a
    // share link, a protection change). The project is the one in the endpoint, else this folder's.
    if (sub === 'api') {
      let method = '';
      for (let j = 0; j < args.length; j++) {
        if ((args[j] === '-X' || args[j] === '--method') && args[j + 1]) method = args[j + 1].toUpperCase();
        else if (/^(-X|--method=)./.test(args[j])) method = args[j].replace(/^(-X|--method=)/, '').toUpperCase();
      }
      const body = args.some((a) => /^(--input|-F|-f|--field|--raw-field|-d|--data)(=|$)/.test(a));
      if ((method === '' || method === 'GET') && !body) return undefined;
      const endpoint = words.find((w, j) => j > 0 && w.startsWith('/')) ?? '';
      const m = /\/projects\/([A-Za-z0-9._-]+)/.exec(endpoint);
      const project = String(m ? m[1] : named ?? projectName(here)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 100);
      // A deploy through the API (or a call whose endpoint can't be read) is a deploy, not a setting:
      // it needs "deploy <project> at <commit> publicly".
      if (!endpoint || /\/(deployments|aliases|alias|promote|rollback|domains)(\/|\?|$)/.test(endpoint)) return { why: `a Vercel deploy through the API (${method || 'POST'} ${endpoint || 'an endpoint it can\'t read'})`, name: project, dir: here };
      return { why: `a change to Vercel's settings for "${project}" (${method || 'POST'} ${endpoint})`, name: project, setting: true };
    }
    // Any other word is a folder to deploy (`vercel <path>`, as Vercel reads it), so it counts.
    const path = sub && !['deploy', 'promote', 'rollback', 'alias', 'redeploy'].includes(sub) ? sub : sub === 'deploy' ? words[1] : undefined;
    const dir = path && !/^https?:/.test(path) ? resolve(String(here ?? '.'), path.replace(/^~(?=\/|$)/, homedir())) : here;
    const project = String(named ?? projectName(dir)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 100);
    const prod = flag('--prod', '--production') || args.some((a) => /^--target=production$/.test(a)) || (args.includes('--target') && args[args.indexOf('--target') + 1] === 'production') || ['promote', 'rollback', 'alias'].includes(sub);
    if (!prod && vercelLinked(dir)) return undefined; // a preview of a linked project: protected
    const prebuilt = args.includes('--prebuilt') ? '.vercel/output' : undefined;
    return { why: prod ? 'a public Vercel production deploy' : 'a first Vercel deploy (it goes to a public production address)', name: project, dir, ...(prebuilt ? { upload: prebuilt } : {}) };
  }
  if (tool === 'netlify') return words[0] === 'deploy' ? { why: 'a Netlify deploy (draft addresses are public too)', name, dir: here, upload: valueOf('--dir', '-d') } : undefined;
  if (tool === 'gh-pages') return { why: 'a GitHub Pages deploy', name, dir: here, upload: valueOf('--dist', '-d') };
  if (tool === 'firebase') return words[0] === 'deploy' || words[0] === 'hosting:channel:deploy' ? { why: 'a Firebase deploy', name, dir: here } : undefined;
  if (tool === 'surge') return words[0] === 'list' || words[0] === 'login' || words[0] === 'whoami' ? undefined : { why: 'a Surge deploy', name, dir: here, upload: valueOf('--project', '-p') ?? words[0] };
  if (tool === 'wrangler') return (words[0] === 'deploy' || words[0] === 'publish' || (words[0] === 'pages' && ['deploy', 'publish'].includes(words[1]))) ? { why: 'a Cloudflare deploy', name, dir: here, upload: words[0] === 'pages' ? words[2] : undefined } : undefined;
  if (tool === 'fly' || tool === 'flyctl') return words[0] === 'deploy' ? { why: 'a Fly deploy', name, dir: here } : undefined;
  return undefined;
}
// The exact version a deploy sends: the folder's commit, and only
// when everything in it is committed, so their Approve is for code they can name and nothing slips in
// after it. { head } or { why } when it can't be told.
export function versionOf(dir) {
  try {
    const opts = { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
    const head = execFileSync('git', ['-C', String(dir ?? '.'), 'rev-parse', '--short=7', 'HEAD'], opts).trim();
    const dirty = execFileSync('git', ['-C', String(dir ?? '.'), 'status', '--porcelain', '--untracked-files=normal'], opts).trim();
    if (dirty) return { why: `it has changes that aren't committed (${dirty.split('\n').length} file${dirty.split('\n').length === 1 ? '' : 's'}): commit them first, so the version the owner approves is the version that goes out` };
    return /^[0-9a-f]{7}$/.test(head) ? { head } : { why: "its version can't be read" };
  } catch {
    return { why: "it isn't a git folder with a commit, so the version the owner approves can't be named" };
  }
}

// Why an uploaded folder isn't the approved commit itself: git-ignored, or not tracked (undefined when
// everything in it is tracked; the clean-tree check already covers changes to tracked files).
export function uploadOutsideCommit(dir, folder) {
  const opts = { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    execFileSync('git', ['-C', String(dir ?? '.'), 'check-ignore', '-q', String(folder)], opts);
    return 'git ignores';
  } catch {
    /* not ignored (or not a git folder: versionOf refuses that) */
  }
  try {
    const tracked = execFileSync('git', ['-C', String(dir ?? '.'), 'ls-files', '--', String(folder)], opts).trim();
    return tracked ? undefined : "isn't committed";
  } catch {
    return "can't be checked";
  }
}

export function deploysIn(cmd, cwd) {
  const out = [];
  for (const seg of segments(cmd)) programAt(seg).forEach((i) => {
    const d = deployAt(seg, i, cwd);
    if (d) out.push(d);
  });
  // git push … gh-pages: publishing the Pages branch.
  for (const seg of segments(cmd)) programAt(seg).forEach((i) => {
    if (basename(seg[i]) === 'git' && seg.slice(i + 1).includes('push') && seg.slice(i + 1).some((a) => /(^|:)gh-pages$/.test(a))) out.push({ why: 'a push to GitHub Pages', name: projectName(cwd).toLowerCase(), dir: cwd });
  });
  return out;
}

// ---- Decide ----
const BROWSER = /^mcp__(claude-in-chrome|plugin_playwright_playwright|playwright)__/;
const LOOK = /(screenshot|read_page|get_page_text|find|snapshot|tabs_context|list_connected|console|network|wait_for|tabs_close|tabs_create|resize|gif_creator|select_browser|switch_browser)/;
const PRIVATE_FILES = /post-approvals\.json|post-approvals\.json\.lock/;

// Decide for one tool call: undefined (not a post: normal rules), 'pass' (approved text: go ahead),
// or { deny } / { ask }. `tabs`: the session's tab -> last URL map (updated in place). `passes` uses
// The owner's one-time passes (tests swap it).
export function decide(tool, input, tabs, session = '', passes = defaultPasses, cwd = process.cwd()) {
  const key = `refs:${String(input?.tabId ?? input?.tab_id ?? 'default')}`;
  const refs = tabs?.[key];
  const d = decideOnce(tool, input, tabs, session, passes, cwd);
  // A refused action never ran, so the page (and its element numbers) is as it was.
  if (refs && d && typeof d === 'object' && 'deny' in d && tabs[key] === undefined) tabs[key] = refs;
  return d;
}

function decideOnce(tool, input, tabs, session = '', passes = defaultPasses, cwd = process.cwd()) {
  input = input ?? {};
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    // Only the owner's Approve writes a pass; no command may touch the file.
    if (PRIVATE_FILES.test(cmd)) return { deny: 'The approved-posts file is written only by the owner\'s Approve on their button; no command may read or change it.' };
    const deploys = deploysIn(cmd, cwd);
    if (deploys.length) {
      const d = deploys[0];
      if (deploys.length > 1 || segments(cmd).length > 1 || words(cmd).some((t) => SEP.has(t))) return { deny: `Public deploys are button-only: this command does ${d.why} alongside other commands. Run the approved deploy on its own. ${DEPLOY_HOW(d.name || '<project>', versionOf(d.dir ?? cwd).head)}` };
      if (!d.name) return { deny: `Public deploys are button-only, and the office can't tell which project this deploys. ${DEPLOY_HOW('<project>')}` };
      if (d.setting) {
        if (passes.target?.(session, cwd, `deploy:${d.name}`)) return 'pass';
        return { deny: `Vercel setting changes are button-only: this is ${d.why}, and the owner hasn't approved a change for "${d.name}". Ask with manager/ask "<the change, in plain words>" --why post --tried "<what you checked>" --text "<what exactly changes and who can then reach it>" --target deploy:${d.name}; their Approve lets one such call through within 2 hours.` };
      }
      const v = versionOf(d.dir ?? cwd);
      if (!v.head) return { deny: `Public deploys are button-only, one approved version at a time: this is ${d.why} of "${d.name}", and ${v.why}.` };
      const up = d.upload ? uploadOutsideCommit(d.dir ?? cwd, d.upload) : undefined;
      if (up) return { deny: `Public deploys are button-only, one approved version at a time: this is ${d.why}, and it uploads ${d.upload}, which ${up}, so it could differ from the commit the owner approves. Let the host build from the approved commit, or commit the built folder.` };
      const text = `deploy ${d.name} at ${v.head} publicly`;
      if (passes.use(text, session, cwd, undefined, `deploy:${d.name}`)) {
        passes.deployed?.(d.name, v.head);
        return 'pass';
      }
      return { deny: `Public deploys are button-only, one approved version at a time: this is ${d.why} of "${d.name}" at ${v.head}, and the owner hasn't approved "${text}". Keep it private (a preview, or the host's protection on), or ${DEPLOY_HOW(d.name, v.head)}` };
    }
    const found = posts(cmd);
    if (!found.length) return undefined;
    const why = found[0].why;
    // One post, and nothing else in the same command: it can't ride on the pass, and can't be changed after the check.
    const allWords = words(cmd);
    if (found.length > 1 || allWords.some((t) => SEP.has(t)) || segments(cmd).length > 1) {
      return { deny: `Public posts are button-only: this command does ${why} alongside other commands. Run the approved post on its own, as a single gh command. ${HOW}` };
    }
    // Making a repo public has no text of its own: the text the owner
    // approves is the fixed sentence "make <owner/repo> public", for that repo.
    const vis = repoGoingPublic(found[0], cwd, passes.repo);
    if (vis !== undefined) {
      if (!vis) return { deny: `Making a repository public is button-only, and the office can't tell for certain which repository this is. Name it in full: gh repo edit owner/repo --visibility public, or gh repo create owner/name --public. ${HOW}` };
      if (passes.use(`make ${vis} public`, session, cwd, undefined, vis)) return 'pass';
      return { deny: `Making a repository public is button-only: the owner hasn't approved "make ${vis} public". Ask with manager/ask "<why>" --why post --tried "<what you did>" --text "make ${vis} public" --target ${vis}; once they approve, run this command on its own within 2 hours.` };
    }
    const text = found[0].why.startsWith('sending data') ? undefined : ghPostText(cmd, found[0], cwd);
    if (text === undefined) return { deny: `Public posts are button-only: this is ${why}, and its exact text can't be read for certain (write it out with -b '<text>' in single quotes, or --body-file <file> holding exactly that text; no $ or backticks the shell would expand, no editors or stdin). ${HOW}` };
    const target = ghTarget(found[0], cwd, passes.repo);
    if (!target) return { deny: `Public posts are button-only, each for one PR or issue: this is ${why}, and the office can't tell for certain which PR or issue it goes on. Name it: the number (gh pr comment 44 ...) and -R owner/repo when you're outside its own folder. ${HOW}` };
    if (passes.use(text, session, cwd, undefined, target)) return 'pass';
    return { deny: `Public posts are button-only (each pass is for one PR or issue): this is ${why} on ${target}, and the owner hasn't approved this exact text there. ${HOW}` };
  }
  if (!BROWSER.test(tool)) return undefined;
  const tab = String(input.tabId ?? input.tab_id ?? 'default');
  const action = String(input.action ?? '');
  const url = typeof input.url === 'string' ? input.url : undefined;
  if (/navigate/.test(tool) && url) {
    delete tabs[`refs:${tab}`]; // element numbers belong to the page they were read on
    tabs[tab] = url;
    tabs._last = tab;
    return undefined; // going to a page is looking; acting on it is what's checked
  }
  if (/computer/.test(tool) && /screenshot|scroll|zoom|wait|hover|mouse_move/.test(action)) return undefined;
  if (LOOK.test(tool)) return undefined;
  const where = tabs[tab] ?? (tab === 'default' && tabs._last ? tabs[tabs._last] : undefined);
  if (!where) {
    // A tab this session never opened (the owner's own tab, a link it followed): the site is unknown.
    return { deny: "Public-post check: this browser action is in a tab this session didn't open, so the office can't tell whether it's a public site. Open the page with navigate first (other sites aren't stopped); posts on public sites are button-only." };
  }
  // Element numbers read earlier stop counting once anything else acts in the tab: a click on a link or
  // a route change can put a different element (a draft's Post button) under the same number.
  const refs = tabs[`refs:${tab}`];
  delete tabs[`refs:${tab}`];
  if (onSocial(where)) {
    const site = hostOf(where);
    // Typing the owner's approved text uses its pass; one click in that tab right after posts it.
    const typed = typeof input.text === 'string' ? input.text : typeof input.value === 'string' ? input.value : undefined;
    // Typing that sends the post itself (the tool's submit, or Enter at the end) counts as the Post click too.
    const submits = input.submit === true || (typed !== undefined && /[\r\n]$/.test(typed));
    if (typed !== undefined && /type|form_input|fill/.test(`${tool} ${action}`) && passes.use(typed, session, cwd, { tab, site }, where, submits)) return 'pass';
    // The one file the owner approved with the post's text: a post approved with a video must not go out as text alone.
    if (/file_upload/.test(tool)) {
      if (passes.upload?.(input.paths, session, cwd, { tab, site }, where)) return 'pass';
      return { deny: `Public posts are button-only, files included: this uploads a file on ${site}, and the owner hasn't approved a post with exactly this file there. Ask with the file on the button: manager/ask "<what and where>" --why post --tried "<what you did>" --text "<the exact text>" --target <the page URL> --media <the file>. Once they approve, upload that one file (unchanged) in the tab, type exactly the text, then one click posts both. A post they approved with a file can't go out without it.` };
    }
    if (/click|key|press/.test(`${tool} ${action}`) && passes.click(session, tab, site)) return 'pass';
    // Deleting one post the owner approved on a --delete button: a few clicks on exactly that page.
    if (/click|key|press/.test(`${tool} ${action}`) && typed === undefined && passes.act?.(session, tab, where, cwd)) return 'pass';
    // A click into the empty compose box before typing the owner's approved text there. It must be on a
    // text box, never a button that sends: a click by screen position alone could land on a saved draft's
    // Post button. The click names its element by number (Chrome's ref, Playwright's ref), and what that
    // number is comes only from the browser's own page reading (Chrome's find or read_page, Playwright's
    // snapshot), in this tab, on this page, in the last few minutes: never from words the click brings
    // along, and never with a screen position the click could use instead.
    // A Playwright click names one element: a second, different one (ref beside target) or a selector could be the one it clicks.
    const pwRef = input.target === undefined || input.ref === undefined || input.target === input.ref ? (input.target ?? input.ref) : undefined;
    const ref = /claude-in-chrome/.test(tool) ? (input.coordinate === undefined ? input.ref : undefined) : input.selector === undefined ? pwRef : undefined;
    const intoBox = refRole(refs, tabs[tab], ref) === 'textbox';
    if (/click/.test(`${tool} ${action}`) && !/key|press/.test(`${tool} ${action}`) && typed === undefined && intoBox && passes.focus?.(session, tab, where, cwd)) {
      if (refs) tabs[`refs:${tab}`] = refs; // a click into the box leaves the page as it was
      return 'pass';
    }
    return { deny: `Public posts are button-only: this browser action is on ${site}, and the owner hasn't approved the text being posted there. ${HOW} Then click into the text box by its element number as the browser's own page reading gave it (in Chrome the ref from find or read_page, in Playwright the ref from browser_snapshot; up to 3 before typing, never by screen position alone), type exactly that text; one click in the same tab to post it is let through for 10 minutes (a post they approved with a file: only once that file is uploaded in the tab). To delete a post: manager/ask "<which post and why>" --why post --tried "<...>" --delete <the post's URL>; their Approve lets a few clicks through in a tab on exactly that page.` };
  }
  return undefined;
}

// What the browser's own page reading said each element number is, kept per tab for a few minutes: Chrome's
// find / read_page, or the snapshot Playwright returns. Only the role is kept (textbox, button, link), from
// the accessibility tree, never the page's label.
const REF_TTL_MS = 5 * 60_000;
const ROLE_OK = /^(textbox|searchbox|combobox)$/;
const PW_TOOL = /^mcp__(plugin_playwright_playwright|playwright)__browser_snapshot$/;
export function recordRefs(tool, input, response, tabs, now = Date.now()) {
  const pw = PW_TOOL.test(String(tool));
  if (!pw && !/^mcp__claude-in-chrome__(find|read_page)$/.test(String(tool))) return false;
  const tab = String(input?.tabId ?? input?.tab_id ?? 'default');
  const texts = [];
  const walk = (v) => {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(response);
  // Chrome find: `ref_1 textbox "Post text"`; read_page: `textbox "Post text" [ref_1] ...`; Playwright:
  // `- textbox "Post text" [ref=e3]`. A line naming more than one ref (a label that holds "[ref_7]") marks
  // every ref on it as no text box, as does a ref seen with two roles.
  const roles = {};
  for (const line of texts.join('\n').split('\n')) {
    let ref, role;
    if (pw) {
      const all = [...line.matchAll(/ref=([\w-]+)/g)].map((x) => x[1]);
      if (all.length !== 1) {
        for (const x of all) roles[x] = 'conflicting'; // a page-written ref hides the real line: its number never counts
        continue;
      }
      const m = line.match(/^\s*-\s*([a-z]+)\b.*\[ref=([\w-]+)\]/);
      if (m) [role, ref] = [m[1], m[2]];
    } else {
      const all = new Set(line.match(/ref_\d+/g) ?? []);
      if (all.size !== 1) {
        for (const x of all) roles[x] = 'conflicting';
        continue;
      }
      const f = line.match(/^\s*-?\s*(ref_\d+)\s+([a-z]+)\b/);
      const r = f ? undefined : line.match(/^\s*-?\s*([a-z]+)\b.*\[(ref_\d+)\]/);
      [ref, role] = f ? [f[1], f[2]] : r ? [r[2], r[1]] : [];
    }
    if (ref) roles[ref] = roles[ref] === undefined || roles[ref] === role ? role : 'conflicting';
  }
  if (!Object.keys(roles).length) return false;
  // Each reading replaces the last: an old number never lives on by riding a newer reading.
  tabs[`refs:${tab}`] = { at: now, page: tabs[tab], roles };
  return true;
}
function refRole(r, page, ref, now = Date.now()) {
  if (typeof ref !== 'string' || !r || typeof page !== 'string' || now - r.at >= REF_TTL_MS || r.page !== page) return undefined;
  const role = r.roles?.[ref];
  return typeof role === 'string' && ROLE_OK.test(role) ? 'textbox' : role;
}

let defaultPasses = { use: () => false, click: () => false };

function stateFile(session) {
  const dir = join(tmpdir(), 'cm-public-post-guard');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${String(session).replace(/[^a-zA-Z0-9-]/g, '')}.json`);
}

const refuse = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));

function saveTabs(file, tabs) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(tabs), { mode: 0o600 });
  renameSync(tmp, file);
}

let isMain = false;
try {
  isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  isMain = false;
}
if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', async () => {
    try {
      const pa = await import('./post-approvals.mjs');
      defaultPasses = {
        use: (text, session, cwd, where, target, submits) => pa.usePass(text, session, Date.now(), pa.approvalsPath(), cwd, where, target, submits),
        act: (session, tab, page, cwd) => pa.useActClick(session, tab, page, Date.now(), pa.approvalsPath(), cwd),
        focus: (session, tab, page, cwd) => pa.useFocusClick(session, tab, page, Date.now(), pa.approvalsPath(), cwd),
        click: (session, tab, site) => pa.useClick(session, tab, site, Date.now(), pa.approvalsPath()),
        upload: (files, session, cwd, where, page) => pa.useUpload(files, session, Date.now(), pa.approvalsPath(), cwd, where, page),
        target: (session, cwd, target) => pa.useTargetPass(session, Date.now(), pa.approvalsPath(), cwd, target),
        deployed: (project, commit) => pa.recordDeploy(project, commit),
      };
      const hook = JSON.parse(raw || '{}');
      const file = stateFile(hook.session_id ?? 'none');
      let tabs = {};
      try {
        tabs = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        // first browser call this session
      }
      const before = JSON.stringify(tabs);
      if (hook.hook_event_name === 'PostToolUse') {
        if (!recordRefs(hook.tool_name, hook.tool_input, hook.tool_response, tabs)) return;
        const key = `refs:${String(hook.tool_input?.tabId ?? hook.tool_input?.tab_id ?? 'default')}`;
        let now = {};
        try {
          now = JSON.parse(readFileSync(file, 'utf8')); // only this tab's readings change; a page opened meanwhile stays
        } catch {
          // none yet
        }
        if (now[key.slice(5)] === tabs[key].page) saveTabs(file, { ...now, [key]: tabs[key] });
        return;
      }
      const d = decide(hook.tool_name, hook.tool_input, tabs, hook.session_id ?? '', defaultPasses, hook.cwd ?? process.cwd());
      if (JSON.stringify(tabs) !== before) saveTabs(file, tabs);
      if (d && typeof d === 'object') {
        if ('deny' in d) refuse(d.deny);
        else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.ask } }));
      }
    } catch {
      // Fail closed for anything that could be a post: a guard problem is never a go-ahead.
      if (/"hook_event_name"\s*:\s*"PostToolUse"/.test(raw)) return; // only notes what the browser read; never a post
      if (/\b(gh|curl|wget|xh|http|vercel|netlify|gh-pages|firebase|surge|wrangler|fly|flyctl)\b|mcp__(claude-in-chrome|plugin_playwright|playwright)__/.test(raw)) refuse('Public-post guard could not check this call; refused to be safe. Try again; if it keeps happening, tell the manager.');
    }
  });
}
