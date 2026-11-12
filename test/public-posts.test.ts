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
  for (const c of ['gh issue view 4', 'gh pr list', 'gh api repos/a/b/issues/4/comments', 'gh pr create --fill', 'gh release create v1.5', 'git push', 'curl https://www.reddit.com/r/programming.json'])
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
  assert.equal(decide(chrome('navigate'), { tabId: 1, url: 'https://www.reddit.com/r/programming/submit' }, tabs, 's', NO), undefined);
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
test("only the owner's approved text gets through, once, in the room that asked, on the PR or issue they approved; anything else is refused", async () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-pass-'));
  const path = join(data, 'post-approvals.json');
  const { grantPass } = await import('../src/team/posts.ts');
  // @ts-expect-error a plain-JS hook module, no type declarations
  const pa = (await import('../hooks/post-approvals.mjs')) as { usePass: (t: string, s: string, now: number, p: string, cwd?: string, where?: unknown, target?: string) => boolean; useClick: (s: string, tab: string, site: string, now: number, p: string) => boolean };
  const passes = { use: (t: string, s: string, cwd?: string, where?: unknown, target?: string) => pa.usePass(t, s, Date.now(), path, cwd, where, target), click: (s: string, tab: string, site: string) => pa.useClick(s, tab, site, Date.now(), path), repo: () => 'owner/lumen' };
  const room = '/Dev/Lumen';
  const D = (command: string, cwd = room, session = 's') => decide('Bash', { command }, {}, session, passes, cwd);
  denies(D('gh pr comment 44 --body "@codex review"'), /hasn't approved/);
  grantPass(path, '@codex review', room, Date.now(), 'owner/lumen#44'); // the owner's Approve on the button
  grantPass(path, '@codex review', room, Date.now(), 'owner/lumen#44'); // the same Approve delivered twice makes one pass
  denies(D('gh pr comment 44 --body "@codex review please"'), /hasn't approved/);
  denies(D('gh pr comment 44 --body "@codex review" && echo asked'), /alongside other commands/);
  denies(D('gh pr comment 44 --body "@codex review"', '/Dev/Atlas'), /hasn't approved/); // another room can't use it
  // Each pass is for one place: only on #44, in that repo.
  denies(D('gh pr comment 43 --body "@codex review"'), /on owner\/lumen#43/);
  denies(D('gh pr comment 44 -R someone/else --body "@codex review"'), /someone\/else#44/);
  denies(D('gh pr comment --body "@codex review"'), /can't tell for certain which PR/); // no number: gh would pick one
  assert.equal(D('gh pr comment 44 --body "@codex review"', '/Dev/Lumen/.claude/worktrees/fix'), 'pass'); // a worktree of the room can
  denies(D('gh pr comment 44 --body "@codex review"'), /hasn't approved/); // used up: one pass, one post
  // A pass from before targets (no target) goes nowhere.
  grantPass(path, 'old', room);
  denies(D('gh pr comment 44 -b old'), /hasn't approved/);
  // An issue's text is its title, a blank line, then the body; a new issue's target is the repo.
  grantPass(path, 'Crash on start\n\nIt crashes  when opened.', room, Date.now(), 'owner/lumen');
  assert.equal(D("gh issue create -t 'Crash on start' -b 'It crashes when opened.'"), 'pass');
  grantPass(path, 'Thanks!', room, Date.now(), 'https://github.com/O/R/issues/1');
  denies(D('gh api repos/o/r/issues/2/comments -f body="Thanks!"'), /o\/r#2/);
  assert.equal(D('gh api repos/o/r/issues/1/comments -f body="Thanks!"'), 'pass');
  grantPass(path, 'Seen', room, Date.now(), 'o/r#7');
  assert.equal(D('gh pr comment https://github.com/o/r/pull/7 -b Seen'), 'pass');
  // Text it can't read for certain is refused outright, approved or not.
  grantPass(path, 'x', room, Date.now(), 'owner/lumen#3');
  for (const c of ['gh pr comment 3 --body-file b.txt', 'gh pr comment 3 -b "$(cat b.txt)"', 'gh pr comment 3 -b `cat b`', "gh api graphql -f query='mutation { addComment }'", 'gh pr review 3 --approve', 'gh pr comment 3 -e'])
    denies(D(c), /.+/);
  // The approved-posts file can't be written by a command.
  denies(D("echo '[]' > ~/.tiny-hq/post-approvals.json"), /only by the owner's Approve/);
  // On a social site: typing the approved text on the approved page uses the pass, then one click in that tab posts it.
  grantPass(path, 'Loved this talk', room, Date.now(), 'https://x.com/compose');
  const tabs: Record<string, string> = {};
  const B = (name: string, input: Record<string, unknown>, session = 'r') => decide(`mcp__claude-in-chrome__${name}`, input, tabs, session, passes, room);
  B('navigate', { tabId: 9, url: 'https://x.com/compose/post' });
  B('navigate', { tabId: 10, url: 'https://www.reddit.com/submit' });
  denies(B('computer', { tabId: 10, action: 'type', text: 'Loved this talk' }), /button-only/); // not the page they approved
  denies(B('computer', { tabId: 9, action: 'type', text: 'Something else' }), /button-only/);
  denies(B('computer', { tabId: 9, action: 'left_click' }), /button-only/); // no click before the approved text
  assert.equal(B('computer', { tabId: 9, action: 'type', text: 'Loved this talk' }), 'pass');
  denies(B('computer', { tabId: 10, action: 'left_click' }), /reddit/); // only in the tab it was typed in
  denies(B('computer', { tabId: 9, action: 'left_click' }, 'another-session'), /button-only/);
  assert.equal(B('computer', { tabId: 9, action: 'left_click' }), 'pass');
  denies(B('computer', { tabId: 9, action: 'left_click' }), /button-only/); // and only once
});

// Making a repo public has no text, so the text the owner approves is
// "make <owner/repo> public", for that repo; it goes through once, and nothing else does.
test('making a repo public needs their Approve of "make owner/repo public", once, for that repo only', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'th-vis-')), 'post-approvals.json');
  const { grantPass } = await import('../src/team/posts.ts');
  // @ts-expect-error a plain-JS hook module, no type declarations
  const pa = (await import('../hooks/post-approvals.mjs')) as { usePass: (t: string, s: string, now: number, p: string, cwd?: string, where?: unknown, target?: string) => boolean };
  const passes = { use: (t: string, s: string, cwd?: string, where?: unknown, target?: string) => pa.usePass(t, s, Date.now(), path, cwd, where, target), click: () => false, repo: () => 'owner/tiny-hq' };
  const room = '/Dev/tiny-hq';
  const D = (command: string) => decide('Bash', { command }, {}, 's', passes, room);
  const flip = 'gh repo edit owner/tiny-hq --visibility public --accept-visibility-change-consequences';
  denies(D(flip), /hasn't approved "make owner\/tiny-hq public"/);
  grantPass(path, 'make owner/tiny-hq public', room, Date.now(), 'owner/tiny-hq');
  denies(D('gh repo edit owner/lumen --visibility public'), /make owner\/lumen public/); // another repo
  denies(D('gh repo create foo --public'), /can't tell for certain/); // no owner named
  assert.equal(D(flip), 'pass');
  denies(D(flip), /hasn't approved/); // once
  assert.equal(D('gh repo edit --visibility private'), undefined); // making it private isn't a post
  // A pass for the folder's repo never flips the repo GH_REPO names, or one on another host.
  grantPass(path, 'make owner/tiny-hq public', room, Date.now(), 'owner/tiny-hq');
  denies(D('GH_REPO=other/secret gh repo edit --visibility public'), /can't tell for certain/); // the repo must be named
  denies(D('GH_HOST=ghe.example.com gh repo edit owner/tiny-hq --visibility public'), /can't tell for certain/);
  denies(D('gh repo edit owner/tiny-hq --visibility public --hostname ghe.example.com'), /can't tell for certain/);
  assert.equal(D('gh repo edit owner/tiny-hq --visibility public'), 'pass'); // the pass was still there
  assert.equal(postingCommand('gh repo edit o/r --visibility=internal'), undefined);
  // Even in its own folder the repo must be named: gh would take a GH_REPO set in the shell first.
  grantPass(path, 'make owner/tiny-hq public', room, Date.now(), 'owner/tiny-hq');
  denies(D('gh repo edit --visibility public --accept-visibility-change-consequences'), /can't tell for certain/);
  // GH_HOST or GH_REPO inherited from the environment count too.
  process.env.GH_HOST = 'ghe.example.com';
  try {
    denies(D('gh repo edit owner/tiny-hq --visibility public'), /can't tell for certain/);
  } finally {
    delete process.env.GH_HOST;
  }
  assert.equal(D('gh repo edit owner/tiny-hq --visibility public'), 'pass');
});

test('a pass never lands on another place: inherited GH_REPO, a body that looks like -R, a page query', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'th-place-')), 'passes.json');
  const { grantPass } = await import('../src/team/posts.ts');
  // @ts-expect-error a plain-JS hook module, no type declarations
  const pa = (await import('../hooks/post-approvals.mjs')) as { usePass: (t: string, s: string, now: number, p: string, cwd?: string, where?: unknown, target?: string) => boolean; sameTarget: (a: string, b: string) => boolean };
  const passes = { use: (t: string, s: string, cwd?: string, where?: unknown, target?: string) => pa.usePass(t, s, Date.now(), path, cwd, where, target), click: () => false, repo: () => 'owner/lumen' };
  const room = '/Dev/Lumen';
  const D = (command: string) => decide('Bash', { command }, {}, 's', passes, room);
  grantPass(path, 'Thanks', room, Date.now(), 'owner/lumen#44');
  process.env.GH_REPO = 'other/secret';
  try {
    denies(D('gh pr comment 44 -b Thanks'), /other\/secret#44/); // gh would post on other/secret
  } finally {
    delete process.env.GH_REPO;
  }
  denies(D('gh pr comment 44 -R other/actual -b "-Rowner/lumen"'), /other\/actual#44/);
  assert.equal(D('gh pr comment 44 -b Thanks'), 'pass');
  assert.equal(pa.sameTarget('https://news.ycombinator.com/item?id=1', 'https://news.ycombinator.com/item?id=2'), false);
  assert.equal(pa.sameTarget('https://news.ycombinator.com/item?id=1', 'https://news.ycombinator.com/item?id=1'), true);
  assert.equal(pa.sameTarget('https://example.com/t?b=2&a=1', 'https://example.com/t?a=1&b=2'), true);
});

test('targets read the same in the hook and the office', async () => {
  const { normTarget } = await import('../src/team/posts.ts');
  // @ts-expect-error a plain-JS hook module, no type declarations
  const pa = (await import('../hooks/post-approvals.mjs')) as { normTarget: (t: string) => string; sameTarget: (a: string, b: string) => boolean };
  const cases: [string, string][] = [['Owner/Lumen#044', 'owner/lumen#44'], ['https://github.com/o/r/pull/44/files', 'o/r#44'], ['github.com/o/r/issues/3', 'o/r#3'], ['o/r', 'o/r'], ['https://www.reddit.com/r/programming/', 'https://reddit.com/r/programming'], ['reddit.com/r/programming', ''], ['#44', ''], ['', '']];
  for (const [i, want] of cases) {
    assert.equal(normTarget(i), want, i);
    assert.equal(pa.normTarget(i), want, i);
  }
  assert.equal(pa.sameTarget('o/r#44', 'O/R#44'), true);
  assert.equal(pa.sameTarget('o/r', 'o/r#44'), false);
  assert.equal(pa.sameTarget('https://reddit.com/r/programming', 'https://reddit.com/r/programming/submit'), true);
  assert.equal(pa.sameTarget('https://reddit.com/r/programming', 'https://reddit.com/r/programmingother'), false);
  assert.equal(pa.sameTarget('', 'o/r#1'), false);
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

// Ways a pass could have landed somewhere else.
test('a pass is never used for another place: comments, repeated flags, flag values and other endpoints are read as gh reads them', () => {
  const seen: (string | undefined)[] = [];
  const P = { use: (_t: string, _s: string, _c?: string, _w?: unknown, target?: string) => (seen.push(target), false), click: () => false, repo: () => 'x/x' };
  const D = (command: string) => decide('Bash', { command }, {}, 's', P, '/x');
  denies(D('gh pr comment 44 -b "t" # -R a/b'), /x\/x#44/); // the comment never runs
  denies(D('gh pr comment -b t # 44'), /can't tell for certain/);
  denies(D('gh repo edit o/r --visibility private --visibility public'), /make o\/r public/); // gh takes the last
  denies(D('gh api --jq repos/o/r/issues/44/comments repos/o/other/issues/1/comments -X POST -f body=T'), /o\/other#1/);
  for (const c of ['gh api -X PATCH repos/o/r/issues/comments/123 -f body=T', 'gh api -X POST repos/o/r/commits/abc/comments -f body=T', 'gh api repos/o/r/pulls -f title=T -f body=B', 'gh api --hostname ghe.x repos/o/r/issues/1/comments -f body=T', 'GH_HOST=ghe.x gh pr comment 4 -b T'])
    denies(D(c), /can't tell for certain/);
  denies(D('gh repo edit --template other/repo --visibility public'), /make other\/repo public/);
  assert.equal(seen.includes('o/r#44'), false);
});

// A first deploy can land on a public address before anyone meant it to. A deploy anyone can open
// without a login needs the owner's "deploy <project> publicly", once.
test('public deploys need the owner\'s Approve for that project; previews of a linked project and reads do not', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = join(mkdtempSync(join(tmpdir(), 'th-deploy-')), 'post-approvals.json');
  const { grantPass } = await import('../src/team/posts.ts');
  // @ts-expect-error a plain-JS hook module, no type declarations
  const pa = (await import('../hooks/post-approvals.mjs')) as { usePass: (t: string, s: string, now: number, p: string, cwd?: string, where?: unknown, target?: string) => boolean };
  const passes = { use: (t: string, s: string, cwd?: string, where?: unknown, target?: string) => pa.usePass(t, s, Date.now(), path, cwd, where, target), click: () => false, repo: () => 'x/x' };
  const room = join(mkdtempSync(join(tmpdir(), 'th-room-')), 'garden-planner');
  mkdirSync(room);
  const git = (...a: string[]) => execFileSync('git', ['-C', room, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(room, 'index.html'), 'v1');
  writeFileSync(join(room, '.gitignore'), '.vercel\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'v1');
  const head = git('rev-parse', '--short=7', 'HEAD');
  const D = (command: string, cwd = room) => decide('Bash', { command }, {}, 's', passes, cwd);
  for (const c of ['vercel --prod', 'npx vercel deploy --prod --yes', 'vercel', 'pnpm dlx vercel@latest --prod', 'netlify deploy --dir dist', 'npx gh-pages -d dist', 'git push origin gh-pages', 'firebase deploy --only hosting', 'wrangler pages deploy dist', 'fly deploy'])
    denies(D(c), /deploy garden-planner at [0-9a-f]{7} publicly/);
  denies(D('vercel --prod && echo done'), /alongside other commands/);
  for (const c of ['vercel ls', 'vercel env pull', 'vercel login', 'echo vercel --prod', 'netlify status', 'git push origin main'])
    assert.equal(D(c), undefined, c);
  // Once linked, a preview is protected and allowed; production still needs the pass.
  mkdirSync(join(room, '.vercel'));
  writeFileSync(join(room, '.vercel', 'project.json'), JSON.stringify({ projectName: 'Garden-Planner' }));
  assert.equal(D('vercel'), undefined);
  denies(D('vercel --prod'), /deploy garden-planner at [0-9a-f]{7} publicly/);
  // Codex on the port: a deploy inside a shell string, a value-taking option before the subcommand,
  // and a deploy of another folder (--cwd, or a folder named on the command).
  denies(D(`bash -c 'vercel --prod'`), /deploy garden-planner at [0-9a-f]{7} publicly/);
  denies(D(`sh -c "npx netlify deploy --dir dist"`), /deploy garden-planner at [0-9a-f]{7} publicly/);
  denies(D('vercel --token abc deploy --prod'), /deploy garden-planner at [0-9a-f]{7} publicly/);
  denies(D('vercel --scope team-x --prod'), /deploy garden-planner at [0-9a-f]{7} publicly/);
  const other = join(room, '..', 'other-project');
  mkdirSync(other);
  grantPass(path, `deploy garden-planner at ${head} publicly`, room, Date.now(), 'deploy:garden-planner');
  denies(D(`vercel --cwd=${other} --prod`), /"other-project"/);
  denies(D('vercel --cwd ../other-project --prod'), /"other-project"/);
  denies(D('vercel ../other-project --prod'), /"other-project"/);
  denies(D('vercel --prod', '/elsewhere/other-room'), /isn't a git folder/);
  // The Approve is for that commit only, with nothing uncommitted.
  writeFileSync(join(room, 'index.html'), 'v2, not approved');
  denies(D('vercel --prod'), /aren't committed/);
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'v2');
  denies(D('vercel --prod'), /hasn't approved "deploy garden-planner at [0-9a-f]{7} publicly"/);
  git('reset', '-q', '--hard', head);
  assert.equal(D('vercel --prod'), 'pass');
  denies(D('vercel --prod'), /hasn't approved/); // once
});

// Text written into a file with a here-document used to be read as commands, so a room writing notes
// or a script that only mentions a deploy or a post was refused. Fed to a shell, it still counts.
test('a here-document is data unless a shell runs it', () => {
  const P = { use: () => false, click: () => false, repo: () => 'x/x' };
  const D = (command: string) => decide('Bash', { command }, {}, 's', P, '/tmp/garden-planner');
  const nl = '\n';
  assert.equal(D(`cat > notes.md <<'EOF'${nl}vercel --prod${nl}gh pr comment 4 -b hi${nl}EOF`), undefined);
  assert.equal(D(`python3 - <<EOF${nl}print("vercel --prod")${nl}EOF`), undefined);
  assert.equal(D(`cat <<-EOF${nl}\tvercel --prod${nl}\tEOF`), undefined);
  denies(D(`bash <<EOF${nl}vercel --prod${nl}EOF`), /button-only/);
  denies(D(`bash -s <<'EOF'${nl}gh pr comment 4 -b hi${nl}EOF`), /button-only/);
  denies(D(`cat > a <<EOF${nl}hello${nl}EOF${nl}vercel --prod`), /button-only/); // after the body: a command again
});

// An approved Vercel share-link call used to be refused as a deploy. A Vercel settings change uses one Approve for that project, whatever its words.
test('a Vercel settings change uses one Approve for that project; reads pass; deploys still need their own text', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cm-vapi-')), 'post-approvals.json');
  const { grantPass } = await import('../src/team/posts.ts');
  // @ts-expect-error a plain-JS hook module, no type declarations
  const pa = (await import('../hooks/post-approvals.mjs')) as { usePass: (t: string, s: string, now: number, p: string, cwd?: string, where?: unknown, target?: string) => boolean; useTargetPass: (s: string, now: number, p: string, cwd?: string, target?: string) => boolean };
  const passes = { use: (t: string, s: string, cwd?: string, where?: unknown, target?: string) => pa.usePass(t, s, Date.now(), path, cwd, where, target), click: () => false, repo: () => 'x/x', target: (s: string, cwd?: string, target?: string) => pa.useTargetPass(s, Date.now(), path, cwd, target) };
  const room = '/Users/x/Dev/garden-planner';
  const D = (command: string, cwd = room) => decide('Bash', { command }, {}, 's', passes, cwd);
  const call = 'vercel api /v1/projects/garden-planner/protection-bypass -X PATCH --input bypass.json';
  denies(D(call), /hasn't approved a change for "garden-planner"/);
  assert.equal(D('vercel api /v9/projects/garden-planner'), undefined); // a read
  grantPass(path, 'create Vercel protection-bypass share link for garden-planner', room, Date.now(), 'deploy:garden-planner');
  denies(D('vercel --prod'), /button-only/); // not a deploy pass
  denies(D('vercel api /v9/projects/other-thing -X DELETE'), /"other-thing"/); // another project
  // A deploy through the API never uses a settings Approve (Codex on the port).
  for (const c of ['vercel api /v13/deployments -X POST --input prod.json', 'vercel api /v2/aliases -X POST --input a.json', 'vercel api /v10/projects/garden-planner/promote/dpl_1 -X POST', 'vercel api -X POST --input x.json'])
    denies(D(c), /button-only/);
  assert.equal(D(call), 'pass');
  denies(D(call), /hasn't approved/); // once
});
