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

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOW = 'Put the exact text to the owner first: manager/ask "<what and where>" --why post --tried "<what you did>" --text "<the exact text>". Once they approve, run the post on its own, with exactly that text written out (-b "<text>"), within 2 hours.';

// ---- Shell words ----
// Enough of sh for this: quotes, backslashes, and the separators ; & | ( ) and newlines (as ";").
export function words(cmd) {
  const out = [];
  let cur = '', q = null, any = false;
  const flush = () => { if (cur || any) out.push(cur); cur = ''; any = false; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') q = null;
      else if (ch === '\\' && i + 1 < cmd.length && '"\\$`\n'.includes(cmd[i + 1])) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; any = true; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { if (cmd[i + 1] !== '\n') cur += cmd[i + 1]; i++; any = true; continue; }
    if (ch === '\n') { flush(); out.push(';'); continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    if (';&|()<>'.includes(ch)) { flush(); out.push(ch); continue; }
    cur += ch; any = true;
  }
  flush();
  return out;
}
const SEP = new Set([';', '&', '|', '(', ')', '<', '>']);

// Commands inside commands: the strings given to bash -c, sh -c, eval, xargs, env, and words that
// themselves look like a command line, are read too.
function segments(cmd, depth = 0) {
  const w = words(String(cmd ?? ''));
  const segs = [[]];
  for (const t of w) {
    if (SEP.has(t)) { if (segs[segs.length - 1].length) segs.push([]); continue; }
    segs[segs.length - 1].push(t);
  }
  const out = segs.filter((s) => s.length);
  // Only text that will be run: after -c (bash -c, sh -lc), or given to eval, xargs, watch and the
  // like. A commit message or grep that merely mentions "gh pr comment" isn't a post.
  const RUNS = new Set(['eval', 'xargs', 'watch', 'nohup', 'time', 'sudo', 'env', 'command', 'exec', 'parallel']);
  if (depth < 3) for (const s of [...out]) s.forEach((t, j) => {
    const runner = /^-[a-z]*c$/.test(s[j - 1] ?? '') || RUNS.has(basename(s[0]));
    if (runner && /\s/.test(t) && /\b(gh|curl|wget|xh|http)\b/.test(t)) out.push(...segments(t, depth + 1));
    // $( … ) and ` … ` are run wherever they sit, quoted words included ("$(gh pr comment …)").
    for (const inner of substitutions(t)) out.push(...segments(inner, depth + 1));
  });
  return out;
}

// The command text inside each $( … ) and ` … ` in a word (balanced parentheses; an unclosed one
// runs to the end of the word, which is read anyway).
export function substitutions(t) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '$' && t[i + 1] === '(' && t[i + 2] !== '(') {
      let depth = 0, k = i + 1;
      for (; k < t.length; k++) {
        if (t[k] === '(') depth++;
        else if (t[k] === ')' && --depth === 0) break;
      }
      out.push(t.slice(i + 2, k));
      i = k;
    } else if (t[i] === '`') {
      const k = t.indexOf('`', i + 1);
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
const WRAPPERS = new Set(['sudo', 'env', 'xargs', 'nohup', 'time', 'command', 'exec', 'watch', 'parallel', 'nice', 'timeout', 'caffeinate']);
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
  if (sub === 'repo' && verb === 'edit' && hasFlag(args, ['--visibility'])) return 'changing who can see a repository';
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
// can't be read for certain: a body file, an editor, stdin, the web form, a GraphQL or API call
// without a literal body, or $ / backticks the shell would expand.
export function ghPostText(cmd, post = posts(cmd)[0]) {
  if (!post || /[`$]/.test(String(cmd))) return undefined;
  const args = post.seg.slice(post.at + 1);
  let title, body, bad = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const val = () => (a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : args[++k]);
    if (flag === '-b' || flag === '--body' || flag === '-c' || flag === '--comment') body = val();
    else if (flag === '-t' || flag === '--title') title = val();
    else if (/^-[bct].+/.test(a)) { if (a[1] === 't') title = a.slice(2); else body = a.slice(2); }
    else if (['-F', '--body-file', '-e', '--editor', '-w', '--web', '--input'].includes(flag)) bad = true;
    else if (flag === '-f' || flag === '--field' || flag === '--raw-field') {
      const kv = val() ?? '';
      const key = kv.slice(0, kv.indexOf('='));
      if (key === 'body') body = kv.slice(kv.indexOf('=') + 1);
      else if (key === 'title') title = kv.slice(kv.indexOf('=') + 1);
      else if (/\bbody\b|comment|message|text|description/.test(key)) bad = true; // more public text than one body
    }
  }
  if (bad) return undefined;
  if (body === undefined) return title;
  return title !== undefined ? `${title}\n\n${body}` : body;
}

// ---- Decide ----
const BROWSER = /^mcp__(claude-in-chrome|plugin_playwright_playwright|playwright)__/;
const LOOK = /(screenshot|read_page|get_page_text|find|snapshot|tabs_context|list_connected|console|network|wait_for|tabs_close|tabs_create|resize|gif_creator|select_browser|switch_browser)/;
const PRIVATE_FILES = /post-approvals\.json|post-approvals\.json\.lock/;

// Decide for one tool call: undefined (not a post: normal rules), 'pass' (approved text: go ahead),
// or { deny } / { ask }. `tabs`: the session's tab -> last URL map (updated in place). `passes` uses
// The owner's one-time passes (tests swap it).
export function decide(tool, input, tabs, session = '', passes = defaultPasses, cwd = process.cwd()) {
  input = input ?? {};
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    // Only the owner's Approve writes a pass; no command may touch the file.
    if (PRIVATE_FILES.test(cmd)) return { deny: 'The approved-posts file is written only by the owner\'s Approve on their button; no command may read or change it.' };
    const found = posts(cmd);
    if (!found.length) return undefined;
    const why = found[0].why;
    // One post, and nothing else in the same command: it can't ride on the pass, and can't be changed after the check.
    const allWords = words(cmd);
    if (found.length > 1 || allWords.some((t) => SEP.has(t)) || segments(cmd).length > 1) {
      return { deny: `Public posts are button-only: this command does ${why} alongside other commands. Run the approved post on its own, as a single gh command. ${HOW}` };
    }
    const text = found[0].why.startsWith('sending data') ? undefined : ghPostText(cmd, found[0]);
    if (text === undefined) return { deny: `Public posts are button-only: this is ${why}, and its exact text can't be read for certain (write it out with -b "<text>"; no $, backticks, files or editors). ${HOW}` };
    if (passes.use(text, session, cwd)) return 'pass';
    return { deny: `Public posts are button-only: this is ${why} whose exact text the owner has not approved. ${HOW}` };
  }
  if (!BROWSER.test(tool)) return undefined;
  const tab = String(input.tabId ?? input.tab_id ?? 'default');
  const action = String(input.action ?? '');
  const url = typeof input.url === 'string' ? input.url : undefined;
  if (/navigate/.test(tool) && url) {
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
  if (onSocial(where)) {
    const site = hostOf(where);
    // Typing the owner's approved text uses its pass; one click in that tab right after posts it.
    const typed = typeof input.text === 'string' ? input.text : typeof input.value === 'string' ? input.value : undefined;
    if (typed !== undefined && /type|form_input|fill/.test(`${tool} ${action}`) && passes.use(typed, session, cwd, { tab, site })) return 'pass';
    if (/click|key|press/.test(`${tool} ${action}`) && passes.click(session, tab, site)) return 'pass';
    return { deny: `Public posts are button-only: this browser action is on ${site}, and the owner hasn't approved the text being posted there. ${HOW} Then type exactly that text; one click in the same tab to post it is let through for 10 minutes.` };
  }
  return undefined;
}

let defaultPasses = { use: () => false, click: () => false };

function stateFile(session) {
  const dir = join(tmpdir(), 'cm-public-post-guard');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${String(session).replace(/[^a-zA-Z0-9-]/g, '')}.json`);
}

const refuse = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));

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
        use: (text, session, cwd, where) => pa.usePass(text, session, Date.now(), pa.approvalsPath(), cwd, where),
        click: (session, tab, site) => pa.useClick(session, tab, site, Date.now(), pa.approvalsPath()),
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
      const d = decide(hook.tool_name, hook.tool_input, tabs, hook.session_id ?? '', defaultPasses, hook.cwd ?? process.cwd());
      if (JSON.stringify(tabs) !== before) writeFileSync(file, JSON.stringify(tabs), { mode: 0o600 });
      if (d && typeof d === 'object') {
        if ('deny' in d) refuse(d.deny);
        else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.ask } }));
      }
    } catch {
      // Fail closed for anything that could be a post: a guard problem is never a go-ahead.
      if (/\b(gh|curl|wget|xh|http)\b|mcp__(claude-in-chrome|plugin_playwright|playwright)__/.test(raw)) refuse('Public-post guard could not check this call; refused to be safe. Try again; if it keeps happening, tell the Claude Manager room.');
    }
  });
}
