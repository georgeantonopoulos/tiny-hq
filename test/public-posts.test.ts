import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
// @ts-expect-error: a plain .mjs hook, no types
import { decide, postingCommand } from '../hooks/public-post-guard.mjs';

// One unapproved post can get the owner's account banned. Posting tools ask them first.
test('public posts ask the owner: gh comments, reviews, issues and API writes; reading and own PRs run as before', () => {
  for (const c of ['gh issue comment 4 --body-file reply.md', 'gh pr review 12 --approve', 'gh pr comment 3 -b hi', 'gh issue create -t Bug -b x', 'gh gist create a.txt --public', "gh api repos/a/b/issues/4/comments -f body='hi'", 'gh api -X POST repos/a/b/pulls/1/reviews', "gh api graphql -f query='mutation { addComment }'", "curl -X POST -d 'text=hi' https://oauth.reddit.com/api/comment"])
    assert.ok(postingCommand(c), c);
  for (const c of ['gh issue view 4', 'gh pr list', 'gh api repos/a/b/issues/4/comments', 'gh pr create --fill', 'gh release create v1.5', 'git push', 'curl https://www.reddit.com/r/vfx.json'])
    assert.equal(postingCommand(c), undefined, c);
});

const NO = { use: () => false, click: () => false };
const denies = (d: unknown, re: RegExp) => {
  assert.ok(d && typeof d === 'object' && 'deny' in d, `expected a refusal, got ${JSON.stringify(d)}`);
  assert.match((d as { deny: string }).deny, re);
};

test('public posts are button-only: browser actions on a social site are refused, looking and other sites are not', () => {
  const tabs: Record<string, string> = {};
  const chrome = (name: string) => `mcp__claude-in-chrome__${name}`;
  assert.equal(decide(chrome('navigate'), { tabId: 1, url: 'https://www.reddit.com/r/vfx/submit' }, tabs, 's', NO), undefined);
  assert.equal(decide(chrome('computer'), { tabId: 1, action: 'screenshot' }, tabs, 's', NO), undefined);
  assert.equal(decide(chrome('get_page_text'), { tabId: 1 }, tabs, 's', NO), undefined);
  denies(decide(chrome('computer'), { tabId: 1, action: 'left_click' }, tabs, 's', NO), /reddit\.com/);
  denies(decide(chrome('form_input'), { tabId: 1, value: 'hello' }, tabs, 's', NO), /button-only/);
  denies(decide(chrome('javascript_tool'), { tabId: 1 }, tabs, 's', NO), /reddit/);
  // Play Console is work, not a post.
  decide(chrome('navigate'), { tabId: 2, url: 'https://play.google.com/console' }, tabs, 's', NO);
  assert.equal(decide(chrome('computer'), { tabId: 2, action: 'left_click' }, tabs, 's', NO), undefined);
  denies(decide('mcp__plugin_playwright_playwright__browser_click', {}, { default: 'https://x.com/home' }, 's', NO), /x\.com/);
  assert.equal(decide('Edit', { file_path: '/a' }, tabs, 's', NO), undefined);
});

test('public posts are button-only: the hook refuses as Claude Code expects, and is quiet otherwise', () => {
  const hook = new URL('../hooks/public-post-guard.mjs', import.meta.url).pathname;
  const data = mkdtempSync(join(tmpdir(), 'cm-posts-'));
  const run = (o: unknown) => execFileSync('node', [hook], { input: typeof o === 'string' ? o : JSON.stringify(o), encoding: 'utf8', env: { ...process.env, CM_DATA_DIR: data } });
  const out = JSON.parse(run({ session_id: 'test-guard', tool_name: 'Bash', tool_input: { command: 'gh issue comment 4 -b hi' } }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /--why post .*--text/);
  assert.equal(run({ session_id: 'test-guard', tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
  assert.equal(run('not json'), '');
  // Every room hears the rule, and the manager keeps the lesson.
  assert.match(readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8'), /nothing goes on a public site without the owner's yes for that exact text/);
  assert.match(readFileSync(new URL('../skills/theoffice/SKILL.md', import.meta.url), 'utf8'), /button-only/);
  assert.match(readFileSync(new URL('../manager/CLAUDE.template.md', import.meta.url), 'utf8'), /6\. \*\*A post is an email\.\*\*/);
});

// A bot command on a pull request can go out because someone approved a permission prompt quickly.
// Now only the owner's Approve on the exact text lets a post through, once, within 2 hours.
test("only the owner's approved text gets through, once, in the room that asked; anything else is refused", async () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-pass-'));
  const path = join(data, 'post-approvals.json');
  const { grantPass } = await import('../src/team/posts.ts');
  // @ts-expect-error a plain-JS hook module, no type declarations
  const pa = (await import('../hooks/post-approvals.mjs')) as { usePass: (t: string, s: string, now: number, p: string, cwd?: string, where?: unknown) => boolean; useClick: (s: string, tab: string, site: string, now: number, p: string) => boolean };
  const passes = { use: (t: string, s: string, cwd?: string, where?: unknown) => pa.usePass(t, s, Date.now(), path, cwd, where), click: (s: string, tab: string, site: string) => pa.useClick(s, tab, site, Date.now(), path) };
  const room = '/Dev/Lumen';
  const D = (command: string, cwd = room, session = 's') => decide('Bash', { command }, {}, session, passes, cwd);
  denies(D('gh pr comment 44 --body "@codex review"'), /not approved/);
  grantPass(path, '@codex review', room); // the owner's Approve on the button
  grantPass(path, '@codex review', room); // the same Approve delivered twice makes one pass
  denies(D('gh pr comment 44 --body "@codex review please"'), /not approved/);
  denies(D('gh pr comment 44 --body "@codex review" && echo asked'), /alongside other commands/);
  denies(D('gh pr comment 44 --body "@codex review"', '/Dev/Atlas'), /not approved/); // another room can't use it
  assert.equal(D('gh pr comment 44 --body "@codex review"', '/Dev/Lumen/.claude/worktrees/fix'), 'pass'); // a worktree of the room can
  denies(D('gh pr comment 44 --body "@codex review"'), /not approved/); // used up: one pass, one post
  // An issue's text is its title, a blank line, then the body; gh api body fields count too.
  grantPass(path, 'Crash on start\n\nIt crashes  when opened.', room);
  assert.equal(D("gh issue create -t 'Crash on start' -b 'It crashes when opened.'"), 'pass');
  grantPass(path, 'Thanks!', room);
  assert.equal(D('gh api repos/o/r/issues/1/comments -f body="Thanks!"'), 'pass');
  // Text it can't read for certain is refused outright, approved or not.
  grantPass(path, 'x', room);
  for (const c of ['gh pr comment 3 --body-file b.txt', 'gh pr comment 3 -b "$(cat b.txt)"', 'gh pr comment 3 -b `cat b`', "gh api graphql -f query='mutation { addComment }'", 'gh pr review 3 --approve', 'gh pr comment 3 -e'])
    denies(D(c), /.+/);
  // The approved-posts file can't be written by a command.
  denies(D("echo '[]' > ~/.tiny-hq/post-approvals.json"), /only by the owner's Approve/);
  // On a social site: typing the approved text uses the pass, then one click in that tab posts it.
  grantPass(path, 'Loved this talk', room);
  const tabs: Record<string, string> = {};
  const B = (name: string, input: Record<string, unknown>, session = 'r') => decide(`mcp__claude-in-chrome__${name}`, input, tabs, session, passes, room);
  B('navigate', { tabId: 9, url: 'https://x.com/compose' });
  B('navigate', { tabId: 10, url: 'https://www.reddit.com/submit' });
  denies(B('computer', { tabId: 9, action: 'type', text: 'Something else' }), /button-only/);
  denies(B('computer', { tabId: 9, action: 'left_click' }), /button-only/); // no click before the approved text
  assert.equal(B('computer', { tabId: 9, action: 'type', text: 'Loved this talk' }), 'pass');
  denies(B('computer', { tabId: 10, action: 'left_click' }), /reddit/); // only in the tab it was typed in
  denies(B('computer', { tabId: 9, action: 'left_click' }, 'another-session'), /button-only/);
  assert.equal(B('computer', { tabId: 9, action: 'left_click' }), 'pass');
  denies(B('computer', { tabId: 9, action: 'left_click' }), /button-only/); // and only once
});

// Every command form that posts is read as a post, wherever gh or curl sits.
test('posts are found behind env vars, paths, wrappers, loops and -c strings; mentions are not posts', () => {
  for (const c of ['GH_REPO=o/r gh pr comment 5 -b hi', '/opt/homebrew/bin/gh pr comment 5 -b hi', 'command gh pr comment 5 -b hi', "bash -c 'gh pr comment 5 -b hi'", 'for i in 5 6; do gh pr comment $i -b hi; done', ' gh pr comment 5 -b hi', 'gh pr -R o/r comment 5 -b hi', "gh alias set c 'pr comment'", 'gh c 5 -b hi', 'gh api repos/o/r/issues/1/comments -f body="graphql"', 'gh api repos/o/r/issues/1/comments -f body="see --method GET"', 'gh api graphql -F query=@m.graphql', 'curl -X POST https://api.github.com/repos/o/r/issues/5/comments -d x', 'curl --request POST https://reddit.com/api/x -dfoo', 'gh pr close 5 -cLGTM', 'gh pr edit 3 --body hi', 'gh repo create x --public'])
    assert.ok(postingCommand(c), c);
  for (const c of ['git commit -m "guard gh pr comment and gh issue create"', 'grep -n "gh pr review" hooks/x.mjs', 'gh pr view 3', 'gh api repos/o/r/pulls/3/comments', 'gh api repos/o/r/issues --method GET -f state=open', 'gh pr create -t x -b y', 'gh release create v1 --notes x', 'curl -F file=@a.zip https://uploads.github.com/repos/o/r/releases/1/assets', 'gh issue close 4', 'gh --version'])
    assert.equal(postingCommand(c), undefined, c);
});

// After review: holes and false alarms.
test('public posts ask the owner: -R flags, comments on close, unopened tabs; reads, mentions and uploads do not', () => {
  for (const c of ['gh -R o/r pr comment 5 -b hi', 'gh --repo=o/r issue create -t x', 'gh issue close 4 -c "fixed, thanks"', 'cd x && gh pr comment 1 -b y', "curl -d 'text=hi' oauth.reddit.com/api/comment"])
    assert.ok(postingCommand(c), c);
  for (const c of ["gh api graphql -f query='query { viewer { login } }'", 'gh api repos/o/r/issues --method GET -f state=open', 'git commit -m "guard gh pr comment and gh issue create"', 'grep -n "gh pr review" hooks/x.mjs', 'curl -F file=@a.zip https://uploads.github.com/repos/o/r/releases/1/assets', 'gh issue close 4'])
    assert.equal(postingCommand(c), undefined, c);
  // A tab this session never opened (the owner's own tab): the site is unknown, so it asks.
  denies(decide('mcp__claude-in-chrome__computer', { tabId: 77, action: 'left_click' }, {}, 's', NO), /didn't open/);
  // Playwright has no tab ids: the last page it opened counts, not the first key on file.
  const tabs: Record<string, string> = {};
  decide('mcp__claude-in-chrome__navigate', { tabId: 1, url: 'https://reddit.com' }, tabs, 's', NO);
  decide('mcp__plugin_playwright_playwright__browser_navigate', { url: 'https://play.google.com/console' }, tabs, 's', NO);
  assert.equal(decide('mcp__plugin_playwright_playwright__browser_click', {}, tabs, 's', NO), undefined);
});
