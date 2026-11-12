// Starts the office: the local token, HTTP on 127.0.0.1 (plus the Tailscale door
// if configured), the floor plan from discovery, and terminals onto the Claude
// Code session in each project's folder. Nothing runs on a timer: the floor is
// rescanned when the page asks, and sessions run only when started.

import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_BIN, CONFIG_PATH, DATA_DIR, REPO_ROOT, DEFAULT_PORT, DEVICES_PATH, LEADS_PATH, MANAGER_NOTES_DIR, MANAGER_DIR, MODELS_PATH, OFFICE_SKILL, WORKER_BRIEF, REMOTE_AUDIT_PATH, SCENE_PATH, TOKEN_PATH } from '../paths.ts';
import { loadConfig } from '../config.ts';
import { BRIEF_PROMPT } from './brief.ts';
import { describeWhen, expired, isDue, lastSlot, loadSchedule, localDay, nextSlot, saveSchedule, schedulePath, withDailyBrief } from '../team/schedule.ts';
import { queuedAfter } from '../terminal/queued.ts';
import { addAsk, answerLine, isPassword, roomLine, typedLinesSince, answersAsk, wantsAction, asksPath, jobAnswered, loadAsks, oldestPerFolder, saveAsks, type Answer, type Ask } from '../team/asks.ts';
import { addDismissed, dismissedPath, loadDismissed, removeDismissed } from '../team/dismissed.ts';
import { goalsPath, loadGoals, setGoal } from '../team/goals.ts';
import { isTrusted, trustFolder } from '../terminal/trust.ts';
import { briefPath, checkLine, decide, describeJobs, isHeld, jobsPath, loadJobs, nudged, nudgeLine, saveJobs, type Job } from '../team/jobs.ts';
import { loadOrCreateToken } from './token.ts';
import { createDaemon, fromWords, type From } from './server.ts';
import { Devices, RateLimit } from './remote.ts';
import { FloorCache } from '../office/cache.ts';
import { discoverProjects, isGone } from '../discovery/scan.ts';
import { MAX_ROOMS, layoutFloor } from '../office/layout.ts';
import { applyScene, loadScene } from '../office/scene.ts';
import { loadLeads, saveLeads, staffRooms, writeNameTag, type Leads } from '../team/leads.ts';
import { managerAddress, promptPending, userEnv, allSessions, extraManagers, extraRoomSessions, interactiveSessions, lastAction, lastActiveAt, lastSaid, liveSessions, MODELS, real, startSession, stopSession, Terminals, waitingOn, worksIn, type BackgroundSession, type Model } from '../terminal/sessions.ts';
import { leftovers, renderStatus, type StatusSession } from '../terminal/status.ts';
import { writeManagerRules } from '../team/manager-rules.ts';
import { Allowance, meters, plan, usageReader, type Plan } from '../team/budget.ts';
import { logStep, loadSteps, pickRoom, stepLine, stepsPath, type Candidate } from '../team/autonomy.ts';
import { addGags, gagsDue, loadGags, saveGags, writeGags } from '../office/gags.ts';
import { checksLogPath, findingsPath, managerLine, KEEP_ON_MANAGER, logCheck, runCheck, saveFinding } from '../team/checks.ts';
import { describeScore, jsonl, score } from '../team/scorecard.ts';
import { listReports, openReport, renderMarkdown, unreadCount } from '../team/desk.ts';
import { approvalsPath, grantPass } from '../team/posts.ts';
import { applyBreak, applyTidy, boardPath, breakDue, brewChat, coffeePrompt, loadCoffee, nextGap, parseCoffee, pickRooms, recentNotes, removeTip, saveCoffee, tidyDue, tidyPrompt } from '../team/coffee.ts';
import { foldIn, loadGhState, lookAtGithub, lookAtInbox, ottoLine, prReposIn, renderGithub, roomFor, saveGhState, tellLine, writeOttoReport, type Gh } from '../team/github.ts';

const token = loadOrCreateToken(TOKEN_PATH);
const config = loadConfig(CONFIG_PATH);
const port = DEFAULT_PORT;

let leads: Leads = loadLeads(LEADS_PATH);

// The model the owner picked for each room, by project folder. The manager's delegate
// command reads the same choice from a plain list next to their notebook.
function loadModels(): Record<string, Model> {
  try {
    const raw = JSON.parse(readFileSync(MODELS_PATH, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, Model] => typeof e[1] === 'string' && (MODELS as readonly string[]).includes(e[1])));
  } catch {
    return {};
  }
}
let models = loadModels();
function saveModels(): void {
  writeFileSync(MODELS_PATH, JSON.stringify(models, null, 2) + '\n', { mode: 0o600 });
  try {
    mkdirSync(MANAGER_NOTES_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(MANAGER_NOTES_DIR, 'models.tsv'), Object.entries(models).map(([p, m]) => `${p}\t${m}`).join('\n') + '\n');
  } catch (err) {
    console.error('could not write the model list for the manager:', err);
  }
}
const floors = new FloorCache(async () => {
  const pinned = config.pinnedProjects.filter((p) => existsSync(p));
  // A folder that's gone (moved or deleted) gets no room and no archive entry.
  const found = (await discoverProjects(undefined, undefined, [...config.extraProjects.filter((p) => existsSync(p)), ...pinned], pinned, config.hiddenProjects, config.projectRoots)).filter((p) => !isGone(p.path));
  // The owner's archived folders (config "archivedProjects") go to the cupboard and stay there,
  // however busy they get.
  const filed = (p: { path: string }) => config.archivedProjects.includes(p.path);
  const projects = [...found.filter((p) => !filed(p)), ...found.filter(filed)];
  const onFloor = Math.min(MAX_ROOMS, found.filter((p) => !filed(p)).length);
  // Every room on the floor gets a character (a name from the list; no model call).
  const staffed = await staffRooms(projects.slice(0, onFloor), leads);
  if (staffed.hired.length) {
    leads = staffed.leads;
    saveLeads(LEADS_PATH, leads);
  }
  const floor = applyScene(layoutFloor(projects, Date.now(), { leads, onFloor, managerName: config.managerName, ownerName: config.ownerName, officeName: config.officeName, github: config.extras.github, coffee: config.extras.coffee }), loadScene(SCENE_PATH));
  writeRoster(floor, projects.slice(onFloor));
  writeBriefs(floor);
  return floor;
});
void floors.get(); // start the first scan straight away

// The note each room's session starts with: its office name, its room, who its manager
// is (agents/worker-brief.md, filled in per room). The office adds it when the owner
// opens a room; the manager's delegate command reads the same files.
type FloorRoom = ReturnType<typeof layoutFloor>['rooms'][number];
function briefFor(room: FloorRoom): string | undefined {
  if (room.kind !== 'project' || !room.project || !room.lead) return undefined;
  let template: string;
  try {
    template = readFileSync(WORKER_BRIEF, 'utf8');
  } catch {
    return undefined;
  }
  const plain = (t: string) => t.replace(/[\x00-\x1f\x7f<>`{}]/g, ' ').trim();
  return template
    .replaceAll('{{name}}', plain(room.lead.name))
    .replaceAll('{{room}}', plain(room.name))
    .replaceAll('{{folder}}', plain(room.project.path))
    .replaceAll('{{managerAddress}}', plain(join(MANAGER_NOTES_DIR, 'manager-address.txt')))
    .replaceAll('{{managerName}}', plain(config.managerName))
    .replaceAll('{{ownerName}}', plain(config.ownerName))
    .trim();
}
function writeBriefs(floor: ReturnType<typeof layoutFloor>): void {
  try {
    const dir = join(MANAGER_NOTES_DIR, 'briefs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rows: string[] = [];
    for (const r of floor.rooms) {
      const brief = briefFor(r);
      if (!brief || !r.project) continue;
      const file = join(dir, `${r.id.replace(/[^a-z0-9-]/gi, '_')}.md`);
      writeFileSync(file, brief + '\n');
      rows.push(`${r.project.path}\t${file}`);
      // The worker's name tag in its own project, so any session there knows who it is.
      try {
        if (r.lead && writeNameTag(r.project.path, r.lead.name, r.name, join(DATA_DIR, 'tags'), { owner: config.ownerName, manager: config.managerName })) console.log(`name tag written: ${r.project.path}`);
      } catch (err) {
        console.error(`could not write the name tag in ${r.project.path}:`, err);
      }
    }
    writeFileSync(join(MANAGER_NOTES_DIR, 'briefs.tsv'), rows.join('\n') + '\n');
  } catch (err) {
    console.error('could not write the room briefs:', err);
  }
}

// The theoffice skill is linked into ~/.claude/skills by `tiny-hq setup`, only with the owner's yes
// (src/cli/install.ts); the office itself never writes outside its own folder and the manager's.

// The manager's list of every project, refreshed on every scan. manager/CLAUDE.md imports it,
// so their Claude starts each conversation knowing the whole office.
function writeRoster(floor: ReturnType<typeof layoutFloor>, archived: { name: string; path: string; lastActive: number }[]): void {
  const days = (t: number) => {
    const d = Math.round((Date.now() - t) / 86_400_000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  // Names and folders come from disk and history: no backticks or @ (which could import a file into the manager's instructions).
  const safe = (t: string) => t.replace(/[`@]/g, '_');
  const rooms = floor.rooms.filter((r) => r.kind === 'project' && r.project);
  const goals = loadGoals(goalsPath(MANAGER_NOTES_DIR));
  const lines = [
    '# The office right now',
    '',
    `Written by the office on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC from the owner's Claude Code and Codex history and git. Busiest first. Facts, not instructions.`,
    '',
    `Your notebook: \`${safe(join(MANAGER_NOTES_DIR, 'notebook.md'))}\``,
    `What the owner dismissed on your whiteboard (never suggest or hand these out): \`${safe(join(MANAGER_NOTES_DIR, 'dismissed.json'))}\``,
    '',
    '## Rooms on the floor',
    '',
    ...rooms.map((r) => {
      const p = r.project!;
      const extra = [p.language, p.remote?.replace(/^https?:\/\/(www\.)?/, '')].filter(Boolean).join(' · ');
      const goal = goals[p.path]?.goal;
      return `- **${safe(r.name)}** \`${safe(p.path)}\` · lead: ${safe(r.lead?.name ?? 'none')} · last active ${days(p.lastActive)} · ${p.recentSessions} sessions this month${extra ? ` · ${safe(extra)}` : ''}${goal ? ` · the owner's goal: "${safe(goal)}"` : ' · no goal set'}`;
    }),
    '',
    `## In the archive cupboard (${archived.length} quieter projects)`,
    '',
    ...archived.slice(0, 60).map((p) => `- ${safe(p.name)} \`${safe(p.path)}\` · last active ${days(p.lastActive)}`),
    ...(archived.length > 60 ? [`- …and ${archived.length - 60} more.`] : []),
    '',
  ];
  try {
    mkdirSync(MANAGER_DIR, { recursive: true });
    writeFileSync(join(MANAGER_DIR, 'office.md'), lines.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  } catch (err) {
    console.error('could not write the manager\'s office list:', err);
  }
}

// The manager reads every project from their own folder: give their Claude access to the project
// folders, in a settings file next to their CLAUDE.md (not in the repo), and forbid file edits
// there (the manager delegates; it never does project work). Only adds: anything Claude Code saved
// there (the owner's "always allow" choices, folders added with /add-dir) is kept. Their
// instructions are written from the template with the owner's settings. Never stops the office from starting.
function prepareManager(): void {
  writeManagerRules(MANAGER_DIR, config, { cli: MANAGER_DIR, data: MANAGER_NOTES_DIR, ownerRulesFile: join(DATA_DIR, 'manager-rules.md') });
  try {
    const dir = join(MANAGER_DIR, '.claude');
    const file = join(dir, 'settings.local.json');
    mkdirSync(dir, { recursive: true });
    let settings: { permissions?: { additionalDirectories?: unknown; deny?: unknown } } & Record<string, unknown> = {};
    if (existsSync(file)) {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return; // not ours to fix
      settings = raw as typeof settings;
    }
    const have = Array.isArray(settings.permissions?.additionalDirectories) ? (settings.permissions!.additionalDirectories as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    mkdirSync(MANAGER_NOTES_DIR, { recursive: true, mode: 0o700 });
    // The notebook used to live in manager/projects.md: bring it along once.
    const oldNotes = join(MANAGER_DIR, 'projects.md');
    const notes = join(MANAGER_NOTES_DIR, 'notebook.md');
    try {
      if (existsSync(oldNotes) && !existsSync(notes)) renameSync(oldNotes, notes);
    } catch (err) {
      console.error("could not move the manager's old notebook:", err); // their folder access is still set up below
    }
    const folders = [...config.projectRoots, ...config.extraProjects].filter((p) => existsSync(p));
    const want = [...folders, MANAGER_NOTES_DIR].filter((p) => existsSync(p) && !have.includes(p));
    const denied = Array.isArray(settings.permissions?.deny) ? (settings.permissions!.deny as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    const deny = folders.map((p) => `Edit(/${p}/**)`).filter((d) => !denied.includes(d));
    if (!want.length && !deny.length) return;
    settings.permissions = { ...(settings.permissions ?? {}), additionalDirectories: [...have, ...want], deny: [...denied, ...deny] };
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    console.error("could not prepare the manager's settings:", err);
  }
}
prepareManager();

// The session a room opens: one that's mid-task first, then the newest.
function pick<T extends { realCwd: string; cwd: string; sessionId?: string; status?: string; startedAt?: number }>(live: T[], path: string): T | undefined {
  return live.filter((s) => worksIn(s.realCwd, path)).sort((a, b) => Number(b.status === 'busy') - Number(a.status === 'busy') || lastActiveAt(b) - lastActiveAt(a))[0];
}

// The owner's way into a folder: the Claude Code session there, in a terminal on the page.
const terminals = new Terminals();
async function openTerminal(projectPath: string, mode: 'join' | 'new' | 'resume', cols: number, rows: number) {
  const isManager = projectPath === MANAGER_DIR;
  const room = isManager ? undefined : (floors.latest()?.rooms ?? []).find((r) => r.kind === 'project' && r.project?.path === projectPath);
  if (!isManager && !room) throw Object.assign(new Error('Not a project on the floor.'), { status: 404 });
  // The session list read a moment ago is good enough (saves a second on every open).
  const live = mode === 'new' ? undefined : pick(await live2s(), projectPath);
  if (!live && mode === 'resume') throw Object.assign(new Error('No session running there.'), { status: 409 });
  const session = isManager ? await theManager(mode === 'new') : (live ?? (await startSession(projectPath, room!.name, undefined, models[projectPath], briefFor(room!))));
  if (!live) liveCache = undefined; // the next status check sees the new session
  // Someone is already watching this session: share that view (instant).
  const term = terminals.forSession(session.id) ?? (await terminals.attach(session.id, cols, rows, isManager));
  return { termId: term.id, session: session.id, fresh: !live };
}

// The owner picks a model for a room: new sessions there start on it, and an idle
// running one switches now (the office types /model into it, as they would).
async function setModel(projectPath: string, model: string): Promise<{ applied: 'now' | 'next' }> {
  const room = (floors.latest()?.rooms ?? []).find((r) => r.kind === 'project' && r.project?.path === projectPath);
  if (!room) throw Object.assign(new Error('Not a project on the floor.'), { status: 404 });
  if (!(MODELS as readonly string[]).includes(model)) throw Object.assign(new Error(`Pick one of ${MODELS.join(', ')}.`), { status: 400 });
  models = { ...models, [projectPath]: model as Model };
  saveModels();
  const live = pick(await live2s(), projectPath);
  if (!live || live.status === 'busy') return { applied: 'next' }; // never type into a session mid-task
  const term = terminals.forSession(live.id) ?? (await terminals.attach(live.id, 120, 32));
  term.write(`/model ${model}\r`);
  return { applied: 'now' };
}

// Who on the floor has a running session: the manager is the manager, each project its lead.
// One `claude agents` read serves every caller for two seconds (the status and
// the speech bubble are asked for together on every poll).
let liveCache: { at: number; list: ReturnType<typeof liveSessions> } | undefined;
function live2s(): ReturnType<typeof liveSessions> {
  if (!liveCache || Date.now() - liveCache.at > 2000) {
    const list = liveSessions();
    liveCache = { at: Date.now(), list };
    list.catch(() => (liveCache = undefined));
  }
  return liveCache.list;
}

let lastManagerTidy = 0;
async function sessions(): Promise<Record<string, 'busy' | 'idle'>> {
  const live = await live2s();
  const out: Record<string, 'busy' | 'idle'> = {};
  const mark = (id: string, path: string) => {
    const here = live.filter((s) => worksIn(s.realCwd, path));
    if (here.length) out[id] = here.some((s) => s.status === 'busy') ? 'busy' : 'idle';
  };
  mark('manager', MANAGER_DIR);
  // A second manager from anywhere (The owner's own terminal, an old office copy): tidy it up.
  if (live.filter((s) => worksIn(s.realCwd, MANAGER_DIR)).length > 1 && Date.now() - lastManagerTidy > 30_000) {
    lastManagerTidy = Date.now();
    void theManager().catch(() => undefined);
  }
  for (const r of floors.latest()?.rooms ?? []) if (r.kind === 'project' && r.project) mark(`lead:${r.id}`, r.project.path);
  // Otto types while they read GitHub or writes their report.
  out.otto = ghBusy || ottoBusy ? 'busy' : 'idle';
  return out;
}

// Every session `claude agents` lists, with its room, last action and (if blocked)
// what it is waiting for. Read from transcripts; no tokens.
async function snapshot(): Promise<{ list: StatusSession[]; rooms: { id: string; name: string; path: string }[] }> {
  const [all, mine] = await Promise.all([allSessions(), interactiveSessions().catch(() => [])]);
  const rooms = (floors.latest()?.rooms ?? []).filter((r) => r.kind === 'project' && r.project).map((r) => ({ id: r.id, name: r.name, path: r.project!.path }));
  const list = all.map((s): StatusSession => {
    const alive = !!s.pid && worksAlive(s.pid);
    // Claude Code also says "blocked" for a session sitting at an empty prompt.
    // It's only really blocked when its transcript shows a question or permission prompt pending.
    // A permission prompt on screen counts too, though Claude Code calls that "working".
    const prompt = alive && s.sessionId ? promptPending(s.sessionId, s.cwd, DATA_DIR) : undefined;
    const wait = prompt ?? (s.state === 'blocked' ? waitingOn(s.sessionId, s.cwd) : undefined);
    const state = prompt ? 'blocked' : wait?.kind === 'unknown' ? 'done' : s.state;
    const room = worksIn(s.realCwd, MANAGER_DIR) ? 'Manager' : rooms.find((r) => worksIn(s.realCwd, r.path))?.name;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      state,
      claudeState: s.state,
      alive,
      startedAt: s.startedAt,
      lastActive: lastActiveAt(s),
      sessionId: s.sessionId,
      cwd: s.realCwd,
      room,
      action: lastAction(s.sessionId, s.cwd)?.text,
      ...(state === 'blocked' && wait ? { waiting: wait } : {}),
    };
  });
  // The owner's own sessions count for the room they're working in: the manager's messages to that room go straight into the owner's chat.
  for (const m of mine) {
    const room = m.realCwd ? (worksIn(m.realCwd, MANAGER_DIR) ? 'Manager' : rooms.find((r) => worksIn(m.realCwd!, r.path))?.name) : undefined;
    list.push({ id: (m.sessionId ?? m.name).slice(0, 8), name: m.name, kind: 'interactive', status: m.status, alive: true, ...(room ? { room } : {}) });
  }
  return { list, rooms };
}
const worksAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Who is blocked on what, by person on the floor (the room cards and the manager's wall show it).
async function waiting(): Promise<Record<string, { kind: string; text: string }>> {
  const { list, rooms } = await snapshot();
  const out: Record<string, { kind: string; text: string }> = {};
  for (const s of list) {
    if (!s.alive || s.state !== 'blocked' || !s.waiting) continue;
    const id = s.room === 'Manager' ? 'manager' : rooms.find((r) => r.name === s.room) ? `lead:${rooms.find((r) => r.name === s.room)!.id}` : undefined;
    if (id) out[id] = s.waiting;
  }
  return out;
}

// The owner's GitHub, watched for other people (src/team/github.ts): every 15 minutes,
// and the manager is told about anything new (again on later ticks if they were busy).
const GH_STATE = join(MANAGER_NOTES_DIR, 'github.json');
const gh: Gh = async (args) => {
  const env = await userEnv();
  return new Promise((resolve, reject) =>
    execFile('gh', args, { env, timeout: 60_000, maxBuffer: 16 << 20 }, (err, out) => (err ? reject(err) : resolve(out))),
  );
};
let ghOwner: string | undefined;
let ghLookedAt = 0;
let ghBusy = false;
// The look takes ~40 s, so it runs alongside the tick; telling the manager happens in the
// tick itself (tellGithub), one at a time with everything else that types into them.
async function lookGithub(): Promise<void> {
  if (Date.now() - ghLookedAt < 15 * 60_000) return;
  ghLookedAt = Date.now();
  try {
    ghOwner ??= (await gh(['api', 'user', '-q', '.login'])).trim();
    const before = loadGhState(GH_STATE);
    const since = before.since ?? (before.checkedAt === undefined ? Date.now() - 7 * 86_400_000 : before.checkedAt) - 60 * 60_000;
    const look = await lookAtGithub(gh, ghOwner, since);
    // The owner's notifications inbox too: org and collaborator repos, mentions, review requests, failed CI, alerts.
    const inboxSince = (before.inboxFrom ?? Date.now() - 7 * 86_400_000) - 60 * 60_000;
    const inbox = await lookAtInbox(gh, ghOwner, inboxSince);
    const after = foldIn(loadGhState(GH_STATE), { ...look, ...inbox }, Date.now(), since + 60 * 60_000);
    saveGhState(GH_STATE, after);
    // Otto words what's new for the manager (Sonnet, no tools); a report already written isn't redone.
    const keys = after.untold.map((i) => i.key);
    if (keys.length && keys.join('\n') !== after.report?.keys.join('\n')) {
      ottoBusy = true;
      try {
        const rooms = (floors.latest()?.rooms ?? []).filter((r) => r.kind === 'project' && r.project).map((r) => ({ name: r.name, remote: r.project!.remote ?? folderRemote(r.project!.path), prRepos: roomPrRepos(r.project!.path) }));
        const withRooms = after.untold.map((i) => ({ ...i, room: roomFor(i.repo, rooms) }));
        const text = await writeOttoReport(withRooms, { claude: CLAUDE_BIN, cwd: join(DATA_DIR, 'otto'), env: await userEnv() });
        const cur = loadGhState(GH_STATE);
        // Each item keeps its room for the manager's line; the write-up is for the bubble and status page.
        const roomOf = new Map(withRooms.map((i) => [i.key, i.room]));
        saveGhState(GH_STATE, { ...cur, untold: cur.untold.map((i) => (roomOf.get(i.key) ? { ...i, room: roomOf.get(i.key) } : i)), ...(text ? { report: { text, at: new Date().toISOString(), keys } } : {}) });
      } finally {
        ottoBusy = false;
      }
    }
  } catch (err) {
    console.error('github: could not look:', err instanceof Error ? err.message.split('\n')[0] : err);
  }
}
let ottoBusy = false;
// Which repos each room opens pull requests on, from its saved chats (last 60 days, newest 40
// files), for Otto's "which room" line. Read only when they write a report; kept for 6 hours.
const prRepoCache = new Map<string, { at: number; repos: Record<string, number> }>();
// The folder's own GitHub remote, when the floor doesn't have it (say the folder is on
// another disk, and another room's chats mention the repo more).
const remoteCache = new Map<string, string | undefined>();
function folderRemote(path: string): string | undefined {
  if (!remoteCache.has(path)) {
    let remote: string | undefined;
    try {
      remote = execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
    } catch {
      /* not a git folder */
    }
    remoteCache.set(path, remote);
  }
  return remoteCache.get(path);
}
function roomPrRepos(path: string): Record<string, number> {
  const hit = prRepoCache.get(path);
  if (hit && Date.now() - hit.at < 6 * 60 * 60_000) return hit.repos;
  // Claude Code has named a folder's chat folder two ways ("Macintosh HD" kept its space once).
  const dirs = [...new Set([path.replace(/[^a-zA-Z0-9]/g, '-'), path.replace(/[^a-zA-Z0-9 ]/g, '-')])].map((d) => join(homedir(), '.claude', 'projects', d));
  let repos: Record<string, number> = {};
  try {
    const files = dirs
      .flatMap((dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)) : []))
      .map((f) => ({ f, t: statSync(f).mtimeMs }))
      .filter((x) => Date.now() - x.t < 60 * 86_400_000)
      .sort((a, b) => b.t - a.t)
      .slice(0, 40);
    repos = prReposIn(files.map((x) => readFileSync(x.f, 'utf8')));
  } catch {
    /* no chats yet */
  }
  prRepoCache.set(path, { at: Date.now(), repos });
  return repos;
}
async function tellGithub(): Promise<void> {
  const state = loadGhState(GH_STATE);
  const untold = state.untold;
  if (!untold.length || ottoBusy) return;
  // Otto's report when it covers exactly what's untold; else the plain list.
  const own = state.report && state.report.keys.join('\n') === untold.map((i) => i.key).join('\n');
  if ((await tellManager(own ? ottoLine(untold) : tellLine(untold))) !== true) return; // busy: next tick
  const told = new Set(untold.map((i) => i.key));
  const now = loadGhState(GH_STATE);
  saveGhState(GH_STATE, { ...now, untold: now.untold.filter((i) => !told.has(i.key)) });
  console.log(`github: ${own ? 'Otto told' : 'told'} the manager about ${told.size} new`);
}

// Left-over blocked sessions (in no room, or their process gone) are closed by the
// office, never handed to the owner. One that won't close is tried again in an hour and
// stays on the status page meanwhile, as an office fault.
const leftoverFailed = new Map<string, number>(); // id -> when closing it last failed
async function closeLeftovers(list: StatusSession[]): Promise<Set<string>> {
  const closed = new Set<string>();
  if (process.env.CM_NO_WARM) return closed; // only the office that owns the port tidies up
  // Right after a restart the floor isn't scanned yet: every session would look roomless.
  const floor = floors.latest();
  if (!floor || !floor.rooms.some((r) => r.kind === 'project')) return closed;
  const now = Date.now();
  const asks = loadAsks(ASKS);
  const asking = new Set(asks.map((a) => a.sessionId).filter(Boolean));
  // A folder with an open question or an unfinished job keeps its sessions (archive projects have no room).
  const busyFolders = [...asks.map((a) => a.folder), ...loadJobs(JOBS).filter((j) => j.status !== 'done').map((j) => j.room)];
  for (const s of leftovers(list, now)) {
    // A session whose process is gone is closed even with a question or job open (a room's
    // 4992d0c4 sat on the status page for hours behind its Merge question). Its question stays up;
    // The owner's answer goes to whoever is in the room then, as it would anyway.
    const held = (s.sessionId && asking.has(s.sessionId)) || (s.cwd && busyFolders.some((f) => worksIn(s.cwd!, f)));
    if ((s.alive && held) || (terminals.forSession(s.id)?.viewers() ?? 0) > 0) continue;
    if (now - (leftoverFailed.get(s.id) ?? 0) < 60 * 60_000) continue;
    try {
      await stopSession(s.id);
      terminals.forSession(s.id)?.close();
      leftoverFailed.delete(s.id);
      closed.add(s.id);
      liveCache = undefined;
      console.log(`closed a left-over session (${s.id}, ${s.name ?? 'unnamed'})`);
    } catch (err) {
      leftoverFailed.set(s.id, now);
      console.error(`could not close left-over session ${s.id}:`, err);
    }
  }
  return closed;
}

// The manager's status page, refreshed every minute and read by them with the Read tool.
async function writeStatus(): Promise<void> {
  try {
    const { list: all, rooms } = await snapshot();
    const closed = await closeLeftovers(all);
    const list = all.filter((x) => !closed.has(x.id));
    mkdirSync(MANAGER_NOTES_DIR, { recursive: true, mode: 0o700 });
    const jobs = `\n\n## Open jobs (the office nudges these rooms until done)\n\n${describeJobs(loadJobs(JOBS), roomName)}\n`;
    const card = `\n## The office, last 24 hours\n\n${[autonomyLine(), ...scorecard()].map((l) => `- ${l}`).join('\n')}\n`;
    writeFileSync(join(MANAGER_NOTES_DIR, 'status.md'), (renderStatus(list, ['Manager', ...rooms.map((r) => r.name)]) + jobs + card + renderGithub(loadGhState(GH_STATE))).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  } catch (err) {
    console.error("could not write the manager's status page:", err);
  }
}

// What each person on the floor said last (The manager, and each project's most recently
// active live session), for their speech bubbles. Read from transcripts; no tokens.
// The pictures each person's last message points at: the page gets only how many, and asks for
// them by person and number, so it can never name a file on the Mac itself.
const saidImages = new Map<string, string[]>();
async function said(): Promise<Record<string, { text: string; at: string; to?: string; images?: number }>> {
  const live = await live2s();
  const out: Record<string, { text: string; at: string; to?: string; images?: number }> = {};
  saidImages.clear();
  const rooms = (floors.latest()?.rooms ?? []).filter((r) => r.kind === 'project' && r.project);
  // Who a message went to, as a person on the floor: the manager, or the room whose
  // session (by name) or lead it was addressed to.
  const who = (to: string): string | undefined => {
    const n = to.toLowerCase();
    if (n === 'manager') return 'manager';
    const s = live.find((x) => x.name?.toLowerCase() === n);
    const r = s ? rooms.find((x) => worksIn(s.realCwd, x.project!.path)) : rooms.find((x) => [x.name, x.lead?.name, x.lead?.name.split(' ')[0]].some((v) => v?.toLowerCase() === n));
    return r ? `lead:${r.id}` : undefined;
  };
  const newestIn = (path: string) => live.filter((s) => worksIn(s.realCwd, path) && s.sessionId).sort((a, b) => lastActiveAt(b) - lastActiveAt(a))[0];
  const add = (id: string, path: string) => {
    const s = newestIn(path);
    const last = s ? lastSaid(s.sessionId, s.cwd) : undefined;
    if (!last) return;
    const { to, images, ...text } = last;
    if (images?.length) saidImages.set(id, images);
    const line = { ...text, ...(images?.length ? { images: images.length } : {}) };
    const toId = to ? who(to) : undefined;
    out[id] = toId && toId !== id ? { ...line, to: toId } : line;
  };
  add('manager', MANAGER_DIR);
  for (const r of floors.latest()?.rooms ?? []) if (r.kind === 'project' && r.project) add(`lead:${r.id}`, r.project.path);
  // Otto's last GitHub report, carried over to the manager.
  const report = loadGhState(GH_STATE).report;
  if (report) out.otto = { text: report.text.slice(0, 600), at: report.at, to: 'manager' };
  return out;
}

const server = createDaemon({
  token,
  port,
  // A picture from a person's last message, by its number (see saidImages).
  saidImage: (who: string, i: number) => saidImages.get(who)?.[i],
  // Over Tailscale (config "remote"): the owner's account plus a paired device; 10 sign-in tries per 10 minutes.
  ...(config.remote ? { remote: { config: config.remote, port: port + 1, devices: new Devices(DEVICES_PATH), signIns: new RateLimit(10, 10 * 60_000), auditPath: REMOTE_AUDIT_PATH } } : {}),
  // The page opens the manager's terminal on this folder.
  floor: async (refresh) => {
    const f = await floors.get(refresh);
    return { ...f, managerPath: MANAGER_DIR, rooms: f.rooms.map((r) => (r.kind === 'project' && r.project && models[r.project.path] ? { ...r, model: models[r.project.path] } : r)) };
  },
  setModel,
  sessions,
  said,
  waiting,
  // The timetable on the manager's wall: every task, when it runs next, and on/off.
  desk: { list: () => listReports(DATA_DIR), open: (id) => openReport(DATA_DIR, id), unread: () => unreadCount(DATA_DIR) },
  coffee: {
    last: () => loadCoffee(DATA_DIR).last,
    board: () => {
      const s = loadCoffee(DATA_DIR);
      let md = '';
      try {
        md = readFileSync(boardPath(DATA_DIR), 'utf8');
      } catch {
        /* none yet */
      }
      return { html: renderMarkdown(md || '# Coffee room board\n\nNothing yet: the first coffee break is still to come.'), tips: s.tips.length, list: s.tips.map((t) => ({ id: t.id, kind: t.kind, text: t.text, from: t.from, seen: t.seen, last: t.last })), ...(s.last ? { lastAt: s.last.at } : {}), ...(s.next ? { next: s.next } : {}) };
    },
    remove: (id) => {
      const next = removeTip(loadCoffee(DATA_DIR), id);
      if (!next) return false;
      saveCoffee(DATA_DIR, next);
      console.log(`coffee: the owner removed a tip from the board`);
      return true;
    },
  },
  schedule: {
    list: () => {
      const now = new Date();
      return {
        tasks: loadSchedule(SCHEDULE).map((t) => ({
          id: t.id,
          title: t.title,
          when: describeWhen(t.when),
          enabled: t.enabled,
          ...(t.until ? { until: t.until } : {}),
          next: expired(t, now) ? null : nextSlot(t.when, now).getTime(),
          lastRun: t.lastRun ?? null,
          createdBy: t.createdBy ?? null,
          prompt: t.prompt,
        })),
      };
    },
    setEnabled: (id, enabled) => {
      const tasks = loadSchedule(SCHEDULE);
      if (!tasks.some((t) => t.id === id)) return false;
      // Switching on counts from now, so it doesn't fire at once for a slot it missed while off.
      saveSchedule(SCHEDULE, tasks.map((t) => (t.id === id ? { ...t, enabled, ...(enabled && !t.enabled ? { since: Date.now() } : {}) } : t)));
      return true;
    },
  },
  // The whiteboard: the manager's notebook as they last wrote it (no tokens).
  board: async () => {
    const file = join(MANAGER_NOTES_DIR, 'notebook.md');
    try {
      return { notebook: readFileSync(file, 'utf8').slice(0, 64 * 1024), updatedAt: statSync(file).mtimeMs, jobs: boardJobs(), dismissed: boardDismissed(), goals: boardGoals(), office: [autonomyLine(), ...scorecard()] };
    } catch {
      return { notebook: '', updatedAt: 0, jobs: boardJobs(), dismissed: boardDismissed(), goals: boardGoals(), office: [autonomyLine(), ...scorecard()] };
    }
  },
  terminal: { open: openTerminal, get: (id) => terminals.get(id) },
  asks: { list: async () => openAsks(), answer: answerAsk },
  // The usage board at the top of the office: the usage meter's last reading, if there is a meter (no tokens).
  gags: () => ({ gags: loadGags(GAGS).gags }),
  usage: async () => {
    void allowance.refresh();
    return { meters: meters(allowance) };
  },
  say: (text, from) => say(text, from),
  lastDone: () => loadJobs(JOBS).reduce((m, j) => (j.status === 'done' ? Math.max(m, j.updatedAt) : m), 0) || undefined,
  // The owner clicked Action on a whiteboard suggestion: typed into the manager's own chat, as the owner's ask.
  boardAction: async (room, next) => {
    const clean = (t: string) => t.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
    const line = `The owner: action this from your whiteboard. ${clean(room)}: ${clean(next)}. (They clicked Action on that suggestion.) Make it a job for that room now: job add, then fill in the brief properly (their words are this whiteboard line; everything the room needs from your notebook, emails and earlier sessions), and send the room the brief path.`;
    const manager = await theManager();
    const live = (await liveSessions()).find((x) => x.id === manager.id);
    if (!live) {
      console.error(`board: Action on "${clean(room)}" not delivered: the manager has no live session`);
      throw Object.assign(new Error("The manager isn't in yet; try again in a moment."), { status: 503 });
    }
    const ok = await typeInto(live, line, true, () => undefined, true);
    if (ok !== true) {
      console.error(`board: Action on "${clean(room)}" not delivered to the manager (${ok === 'later' ? 'their screen never came up' : 'line not seen in their chat'})`);
      throw Object.assign(new Error("Couldn't get it to the manager; try again."), { status: 503 });
    }
    console.log(`board: the owner actioned "${clean(room)}: ${clean(next)}"; the manager has it`);
  },
  // The owner set (or cleared) a room's goal on the whiteboard: saved, then the manager is told.
  boardGoal: async (folder, goal) => {
    const room = (floors.latest()?.rooms ?? []).find((r) => r.kind === 'project' && r.project?.path === folder);
    if (!room) throw Object.assign(new Error('That room is no longer on the floor; reload the page.'), { status: 404 });
    const g = setGoal(GOALS, folder, goal);
    await tellManagerNow(
      g
        ? `The owner set the goal for ${room.name}: "${g}". (They typed it on your whiteboard.) Steer that room's Next line and its jobs toward it; it's in ${GOALS}.`
        : `The owner cleared the goal for ${room.name} on your whiteboard. It has no goal now.`,
    );
    console.log(`board: the owner ${g ? `set ${room.name}'s goal: "${g}"` : `cleared ${room.name}'s goal`}`);
  },
  // The owner clicked × on a whiteboard suggestion or job: they don't want it actioned.
  // Saved first (the whiteboard hides it and the manager's instructions point at the file),
  // a dismissed job is closed so nothing nudges it, then the manager is told in their chat.
  boardDismiss: async (room, text, jobId, undo) => {
    if (undo) return boardBringBack(room, text);
    let job: Job | undefined;
    if (jobId) {
      saveJobs(JOBS, loadJobs(JOBS).map((j) => {
        if (j.id !== jobId || j.status === 'done') return j;
        job = j;
        const { waitingFor: _w, ...rest } = j;
        return { ...rest, status: 'done' as const, updatedAt: Date.now() };
      }));
    }
    // Remember the job only if this click closed it, so Bring back never reopens one that was already finished.
    const item = addDismissed(DISMISSED, room, text, job?.id, Date.now(), job?.status === 'waiting' ? job.waitingFor : undefined);
    // A job waiting on the owner had an Approve button over the room's head: it goes too.
    if (job) saveAsks(ASKS, loadAsks(ASKS).filter((a) => a.job !== job!.id));
    const line = job
      ? `The owner: drop job ${job.id} (${item.room}: ${item.text}). They clicked × on it on your whiteboard: they don't want it actioned. The office has closed the job. Tell the room to stop work on it, take it out of your notebook, and don't bring it back. It's in ${DISMISSED}.`
      : `The owner: don't action this from your whiteboard. ${item.room}: ${item.text}. (They clicked × on it.) Take it off your notebook's Next line, don't suggest it again or hand it out, and pick a different Next for that room. It's in ${DISMISSED}.`;
    await tellManagerNow(line);
    console.log(`board: the owner dismissed "${item.room}: ${item.text}"${job ? ` (job ${job.id} closed)` : ''}`);
  },
});

// The manager is kept warm: their session is started (if none is running) and a viewer
// attached, so opening their office is instant. An idle session costs no tokens.
async function warmManager(): Promise<void> {
  try {
    const session = await theManager();
    if (!terminals.forSession(session.id)) await terminals.attach(session.id, 120, 36, true);
  } catch (err) {
    console.error('could not keep the manager warm:', err);
  }
}

// The one manager. Everything that needs them comes through here: starts are shared
// (two callers at once get the same new session, not one each), and any other
// session in their folder is stopped once idle. `fresh`: the owner asked for a new
// conversation, so the new one becomes the manager and the old one is retired.
let managerStarting: Promise<BackgroundSession> | undefined;
// The the manager everyone is pointed at, and when they became it. They stay the manager while he
// runs, even if an old one is busy (so the tidy-up never stops the one the owner uses).
let manager: { s: BackgroundSession; at: number } | undefined;
const MANAGER_CATCH_UP =
  "[Office: you're starting a new conversation] Catch up before anything else: read your notebook (~/.tiny-hq/manager/notebook.md), your status page (~/.tiny-hq/manager/status.md), and run ~/.tiny-hq/app/manager/job list and ~/.tiny-hq/app/manager/ask list. Any room that's gone quiet on an open job: send it its next step. Then reply in one line: what's open and what's waiting on the owner.";
async function theManager(fresh = false): Promise<BackgroundSession> {
  if (managerStarting) return managerStarting;
  const readAt = Date.now();
  const live = fresh ? [] : await liveSessions();
  if (managerStarting) return managerStarting; // another caller got here during the read
  if (!fresh && manager && manager.at > readAt) return manager.s; // one was started while we read: that's the manager
  const keep = fresh ? undefined : (live.find((x) => x.id === manager?.s.id) ?? pick(live, MANAGER_DIR));
  if (keep) {
    // Found rather than started (say, after an office restart): they're been the manager since their session started.
    // A new manager not listed yet: don't fall back to the older one they replaced.
    if (manager && manager.s.id !== keep.id && (keep.startedAt ?? 0) < manager.at && Date.now() - manager.at < 5 * 60_000) return manager.s;
    if (manager?.s.id !== keep.id) manager = { s: keep, at: keep.startedAt ?? Date.now() };
    void retireExtraManagers(keep.id);
    return keep;
  }
  // A new manager starts by catching up, so they know what's open before the owner or a room says a word.
  managerStarting = startSession(MANAGER_DIR, 'Manager', MANAGER_CATCH_UP)
    .then((started) => {
      manager = { s: started, at: Date.now() };
      return started;
    })
    .finally(() => {
      managerStarting = undefined;
      liveCache = undefined;
    });
  const started = await managerStarting;
  void retireExtraManagers(started.id);
  return started;
}

// The manager's timetable (~/.tiny-hq/manager/schedule.json): the office runs every
// due task by typing its prompt into the manager's session, one at a time, and only when
// it's safe: their screen is up, they aren't mid-reply, and the owner isn't watching (so
// it never lands in the middle of something the owner is typing). It then checks the
// prompt reached their conversation; a task is marked as run only once it got there,
// and is retried next minute (up to three times per slot). The daily brief is the
// office's own task, added once from config "briefingTime".
const SCHEDULE = schedulePath(MANAGER_NOTES_DIR);
{
  const legacy = (() => {
    try {
      return readFileSync(join(MANAGER_NOTES_DIR, 'last-brief'), 'utf8').trim();
    } catch {
      return undefined;
    }
  })();
  const tasks = loadSchedule(SCHEDULE);
  const seeded = withDailyBrief(tasks, config.briefingTime ?? '08:30', BRIEF_PROMPT);
  if (seeded !== tasks) {
    // Today's brief already ran under the old timer: don't run it twice.
    if (legacy === localDay(new Date())) seeded[0]!.lastRun = statSync(join(MANAGER_NOTES_DIR, 'last-brief')).mtimeMs;
    saveSchedule(SCHEDULE, seeded);
  }
}
const tries = new Map<string, { slot: number; n: number }>();
let scheduleBusy = false;
// Timed checks the checker is doing now, and what it found that the manager still has to hear.
const checking = new Set<string>();
// Saved to disk, so a finding survives an office restart (the slot is already marked run).
const FOR_MANAGER = join(MANAGER_NOTES_DIR, 'checks-for-manager.json');
type ForManager = { id: string; line: string; tries?: number };
const loadForManager = (): ForManager[] => {
  try {
    const raw = JSON.parse(readFileSync(FOR_MANAGER, 'utf8')) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is ForManager => !!x && typeof x.id === 'string' && typeof x.line === 'string').slice(0, 50) : [];
  } catch {
    return [];
  }
};
const forManager: ForManager[] = loadForManager();
const saveForManager = () => {
  try {
    writeFileSync(FOR_MANAGER, JSON.stringify(forManager), { mode: 0o600 });
  } catch (err) {
    console.error('timetable: could not save what the checker found:', err);
  }
};
const queueForManager = (item: ForManager) => {
  forManager.push(item);
  saveForManager();
};
const CHECKS_LOG = checksLogPath(MANAGER_NOTES_DIR);
// The day the manager last got a fresh morning conversation (once a day, whatever the session list says).
let freshDay = '';
// Re-read before writing: the owner may have switched something while a task ran.
const markRun = (id: string) => saveSchedule(SCHEDULE, loadSchedule(SCHEDULE).map((t) => (t.id === id ? { ...t, lastRun: Date.now() } : t)));
async function runSchedule(): Promise<void> {
  if (scheduleBusy) return;
  scheduleBusy = true;
  try {
    // First, anything the checker found: the manager hears it once they're free.
    // A line that was typed but never showed in their chat counts as tried; after 3 it's dropped
    // (it most likely landed late), so one line can't be typed into them every minute.
    const next = forManager[0];
    let managerFree = true;
    if (next) {
      const ok = await tellManager(next.line);
      if (ok === 'later') managerFree = false;
      else {
        next.tries = (next.tries ?? 0) + 1;
        if (ok === true || next.tries >= 3) {
          forManager.shift();
          if (ok === true) console.log(`timetable: the manager has what the checker found for "${next.id}"`);
          else console.error(`timetable: gave up telling the manager about "${next.id}" after 3 tries`);
        }
        saveForManager();
        return; // one line into the manager per minute
      }
    }
    const now = new Date();
    const due = loadSchedule(SCHEDULE).filter((t) => !checking.has(t.id) && isDue(t, now) && (tries.get(t.id)?.slot !== lastSlot(t.when, now).getTime() || tries.get(t.id)!.n < 3));
    // Checks go to the checker (several at once is fine: each is a small separate Claude).
    for (const task of due.filter((t) => !KEEP_ON_MANAGER.has(t.id))) {
      checking.add(task.id);
      const prompt = task.prompt.replace(/\s+/g, ' ');
      void userEnv()
        .then((env) => runCheck(task.title, prompt, { claude: CLAUDE_BIN, cwd: join(DATA_DIR, 'checks'), repo: REPO_ROOT, env, notesDir: MANAGER_NOTES_DIR }))
        .then((r) => {
          logCheck(CHECKS_LOG, { id: task.id, at: Date.now(), kind: r.kind });
          if (r.kind === 'quiet') console.log(`timetable: "${task.title}" checked, nothing new (The manager not woken)`);
          else {
            saveFinding(findingsPath(MANAGER_NOTES_DIR), { id: task.id, title: task.title, kind: r.kind, text: r.text, at: Date.now() });
            queueForManager({ id: task.id, line: managerLine(task.title, prompt, r, findingsPath(MANAGER_NOTES_DIR), task.id) });
          }
          markRun(task.id);
        })
        .catch((err) => {
          // The checker failed: the manager does it the old way, so nothing is missed.
          console.error(`timetable: checker failed on "${task.title}", passing it to the manager:`, String(err).slice(0, 200));
          logCheck(CHECKS_LOG, { id: task.id, at: Date.now(), kind: 'failed' });
          queueForManager({ id: task.id, line: `[Scheduled: ${task.title}] ${prompt}` });
          markRun(task.id);
        })
        .finally(() => checking.delete(task.id));
    }
    const task = due.find((t) => KEEP_ON_MANAGER.has(t.id));
    if (!task || !managerFree) return;
    // The morning brief starts a fresh manager conversation: everything they need is in their
    // notebook, status page and job list, and a day-old conversation re-reads ~300k tokens a step.
    if (task.id === 'daily-brief' && manager && manager.at < startOfToday() && freshDay !== localDay(now)) {
      const live = (await liveSessions()).find((x) => x.id === manager!.s.id);
      const watched = (terminals.forSession(manager.s.id)?.viewers() ?? 0) > 0;
      if (live && (live.status === 'busy' || watched)) return; // next minute
      freshDay = localDay(now);
      await theManager(true);
      console.log('timetable: fresh manager conversation for the morning brief');
      return; // they catch up first; the brief follows once they're free
    }
    const slot = lastSlot(task.when, now).getTime();
    const tried = tries.get(task.id);
    const ok = await tellManager(`[Scheduled: ${task.title}] ${task.prompt}`.replace(/\s+/g, ' '), () => tries.set(task.id, { slot, n: tried?.slot === slot ? tried.n + 1 : 1 }));
    if (ok === 'later') return; // not safe yet: next minute
    if (ok) {
      markRun(task.id);
      console.log(`timetable: the manager has "${task.title}"`);
    } else console.error(`timetable: "${task.title}" didn't reach the manager (try ${tries.get(task.id)?.n} of 3)`);
  } catch (err) {
    console.error('timetable: could not run a task:', err);
  } finally {
    scheduleBusy = false;
  }
}
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Types one line into the manager's session when it's safe, then checks it reached their
// conversation. 'later': not safe right now. `onTry` runs just before typing.
async function tellManager(line: string, onTry: () => void = () => undefined): Promise<boolean | 'later'> {
  const manager = await theManager();
  const live = (await liveSessions()).find((x) => x.id === manager.id);
  if (!live?.sessionId || live.status === 'busy') return 'later';
  return typeInto(live, line, true, onTry);
}

// Types one line into a session (The manager's, or a room's) when nobody is watching it
// and its screen is up, then checks the line reached its conversation.
// `owner`: the owner asked for it (their click), so go ahead even while they're watching,
// and wait a few seconds for a fresh screen to come up.
const typing = new Map<string, Promise<unknown>>(); // session id -> the line being typed into it now
async function typeInto(s: { id: string; sessionId?: string; cwd: string }, line: string, keep: boolean, onTry: () => void = () => undefined, owner = false): Promise<boolean | 'later'> {
  // One line at a time per session: each is typed, then Enter half a second later, and a second
  // line arriving in between (The owner's mic while a nudge is mid-way) would merge the two.
  const before = typing.get(s.id) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(() => typeIntoNow(s, line, keep, onTry, owner));
  typing.set(s.id, mine);
  try {
    return await mine;
  } finally {
    if (typing.get(s.id) === mine) typing.delete(s.id);
  }
}
async function typeIntoNow(s: { id: string; sessionId?: string; cwd: string }, line: string, keep: boolean, onTry: () => void, owner: boolean): Promise<boolean | 'later'> {
  if (!s.sessionId) return 'later';
  const term = terminals.forSession(s.id) ?? (await terminals.attach(s.id, 120, 36, keep));
  if (owner) for (let i = 0; i < 20 && !term.ready(); i++) await new Promise((r) => setTimeout(r, 500));
  if ((!owner && term.viewers() > 0) || !term.ready()) return 'later';
  // The owner is halfway through a message there (a phone page can stop counting as a viewer): wait.
  if (!owner && term.drafting()) return 'later';
  const transcript = join(homedir(), '.claude', 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`);
  let before = 0;
  try {
    before = statSync(transcript).size;
  } catch {
    // no transcript yet
  }
  onTry();
  term.write(line);
  await new Promise((r) => setTimeout(r, 500));
  let typed = before;
  try {
    typed = statSync(transcript).size;
  } catch {
    // no transcript yet
  }
  term.write('\r');
  // An idle session writes the line to the transcript at once. A busy one only notes that a message
  // was queued, and writes the line itself when it gets to it, which can be minutes later: so the
  // line, or a queued message right after our Enter, means it landed. (Waiting for the line alone,
  // The owner's answer to a busy the manager counted as failed and their question came back.)
  const needle = JSON.stringify(line.slice(0, 60)).slice(1, -1);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const fd = openSync(transcript, 'r');
      try {
        const len = Math.min(fstatSync(fd).size - before, 512 * 1024);
        if (len > 0) {
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, before);
          const text = buf.toString('utf8');
          if (text.includes(needle) || queuedAfter(text, typed - before)) return true;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      /* transcript not there yet */
    }
  }
  return false;
}

// Asks: a yes/no question a session put on the floor (manager/ask). The owner answers
// with the button over that person's head; the office types their answer into
// that session's own chat.
const ASKS = asksPath(MANAGER_NOTES_DIR);
function personFor(folder: string): { id: string; path: string } | undefined {
  if (worksIn(folder, MANAGER_DIR)) return { id: 'manager', path: MANAGER_DIR };
  const r = (floors.latest()?.rooms ?? []).find((x) => x.kind === 'project' && x.project && worksIn(folder, x.project.path));
  return r?.project ? { id: `lead:${r.id}`, path: r.project.path } : undefined;
}
function openAsks(): Record<string, { id: string; question: string; more?: number; options?: string[]; tried?: string; password?: boolean; post?: string }> {
  const out: Record<string, { id: string; question: string; more?: number; options?: string[]; tried?: string; password?: boolean; post?: string }> = {};
  // A "Trust and start" button for a folder that isn't a room on the floor (an archive project like
  // in the cupboard) shows over the manager's head, ahead of their own questions: otherwise the owner could never see it.
  const offFloorTrust = (a: Ask) => !!a.trust && !personFor(a.folder);
  const shown = oldestPerFolder(loadAsks(ASKS)).sort((x, y) => Number(offFloorTrust(y.ask)) - Number(offFloorTrust(x.ask)));
  for (const { ask, more } of shown) {
    const who = personFor(ask.folder) ?? (offFloorTrust(ask) ? { id: 'manager' } : undefined);
    if (who && !out[who.id]) out[who.id] = { id: ask.id, question: ask.question, ...(more ? { more } : {}), ...(ask.options ? { options: ask.options } : {}), ...(ask.tried ? { tried: ask.tried } : {}), ...(isPassword(ask) ? { password: true } : {}), ...(ask.post ? { post: ask.post } : {}), ...(ask.post ? { target: ask.target ?? postTargetGuess(ask) ?? '' } : {}) };
  }
  return out;
}
async function answerAsk(id: string, answer: Answer, from?: From): Promise<void> {
  const ask = loadAsks(ASKS).find((a) => a.id === id);
  if (!ask) throw Object.assign(new Error('That question was already answered or withdrawn.'), { status: 404 });
  if (!answerLine(ask, answer)) throw Object.assign(new Error("That answer doesn't fit this question; reload the page."), { status: 400 });
  // Claim it before typing, so a second tap (or another device) can't deliver the same answer twice
  // while this one is on its way (that takes seconds). Put back if it doesn't land.
  saveAsks(ASKS, loadAsks(ASKS).filter((a) => a.id !== id));
  const restore = () => saveAsks(ASKS, [...loadAsks(ASKS).filter((a) => a.id !== id), ask]);
  try {
    await deliverAnswer(ask, answer, from);
  } catch (err) {
    if ((err as { status?: number }).status !== 410) restore();
    throw err;
  }
}
// Approved (or, for the room's own question a job rides on, any answer): the job is back to work
// (nudged again if the room goes quiet).
function resumeJob(ask: Ask, answer: Answer): void {
  const resume = jobAnswered(ask, answer);
  if (!resume) return;
  saveJobs(JOBS, loadJobs(JOBS).map((j: Job) => {
    if (j.id !== resume || j.status !== 'waiting') return j;
    const { waitingFor: _w, ...back } = j;
    return { ...back, status: 'active' as const, updatedAt: Date.now(), lastNudge: Date.now(), nudgesToday: 0 };
  }));
}

// Where a post button from before --target goes: the "#N" in its question, in the asking
// folder's GitHub repo. Undefined when the question names no single number: its pass then goes nowhere.
function postTargetGuess(ask: Ask): string | undefined {
  const nums = [...new Set([...ask.question.matchAll(/#(\d+)\b/g)].map((m) => m[1]))];
  if (nums.length !== 1) return undefined;
  try {
    const url = execFileSync('git', ['-C', ask.folder, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/github\.com[:/]([A-Za-z0-9-]+\/[\w.-]+?)(?:\.git)?$/i);
    return m?.[1] ? `${m[1].toLowerCase()}#${nums[0]}` : undefined;
  } catch {
    return undefined;
  }
}

// Start a room's session with a first message (the same hand-off as the manager's delegate). Throws (503)
// only when nothing started: a session may start before a failure, and the room must never get two.
// One start per room at a time: a second answer waits for it and is typed into that session.
const startingRooms = new Map<string, Promise<void>>();
function startRoomWith(path: string, name: string, task: string): Promise<void> {
  const p = startRoomNow(path, name, task).finally(() => startingRooms.delete(path));
  startingRooms.set(path, p);
  return p;
}
async function startRoomNow(path: string, name: string, task: string): Promise<void> {
  const env = { ...(await userEnv()), CM_CLAUDE_BIN: CLAUDE_BIN, CM_DATA_DIR: DATA_DIR };
  const err = await new Promise<string | undefined>((resolve) =>
    execFile(join(MANAGER_DIR, 'delegate'), [path, name, task], { env, timeout: 60_000 }, (e, _o, stderr) => resolve(e ? String(stderr || e.message).trim().slice(0, 200) : undefined)),
  );
  liveCache = undefined;
  const started = (await liveSessions()).some((x) => worksIn(x.realCwd, path));
  if (err && !started) throw Object.assign(new Error(`${name}'s session didn't start: ${err}`), { status: 503 });
  console.log(`asks: started ${name}'s session with the owner's answer`);
}
async function trustAndStart(folder: string, name: string, task: string): Promise<void> {
  trustFolder(folder);
  const env = { ...(await userEnv()), CM_CLAUDE_BIN: CLAUDE_BIN, CM_DATA_DIR: DATA_DIR };
  await new Promise<void>((resolve, reject) =>
    execFile(join(MANAGER_DIR, 'delegate'), [folder, name, task], { env, timeout: 60_000 }, (err, _out, stderr) =>
      err ? reject(Object.assign(new Error(`Trusted, but the session didn't start: ${String(stderr || err.message).trim().slice(0, 200)}`), { status: 503 })) : resolve(),
    ),
  );
  console.log(`asks: the owner trusted ${folder}; started ${name}'s session`);
}
async function deliverAnswer(ask: Ask, answer: Answer, from?: From): Promise<void> {
  // Where they answered from: a room that hears about a problem knows which device they saw it on.
  const where = from ? ` (They answered ${fromWords(from)}.)` : '';
  const line = answerLine(ask, answer)! + where; // checked by answerAsk
  const yes = 'yes' in answer && answer.yes;
  // Button-only posts: the owner's Approve on a post's exact text is the one way it can go up.
  if (yes && ask.post) {
    // For that PR/issue only; a button from before --target names it in its question ("PR #44").
    grantPass(approvalsPath(DATA_DIR), ask.post, ask.folder, Date.now(), ask.target ?? postTargetGuess(ask) ?? '');
    console.log(`posts: the owner approved a post's exact text for ${roomName(ask.folder)} (one-time pass, 2 hours)`);
  }
  const id = ask.id;
  const who = personFor(ask.folder);
  const live = (await liveSessions()).filter((x) => x.realCwd === ask.folder || (who && worksIn(x.realCwd, who.path)));
  // The session that asked, if it said who it is (several can share a folder); else the room's latest.
  // "Trust and start" approved: the owner's own click trusts the folder for Claude Code, then the
  // office starts the session the hand-off couldn't (manager/delegate with the same task).
  if (ask.trust && yes) await trustAndStart(ask.folder, ask.trust.name, ask.trust.task);
  const asker = ask.sessionId ? (await liveSessions()).find((x) => x.sessionId === ask.sessionId) : undefined;
  // A question the manager put over a room (ask --room): the owner's answer goes into the room's own chat as
  // their own click (the room acts on it, no second button), and the manager gets a copy for their notebook.
  const toRoom = ((t) => (t ? t + where : t))(roomLine(ask, answer));
  if (toRoom && who && who.id !== 'manager') {
    // Background sessions in the room (the owner's own terminal sessions aren't in this list).
    const starting = startingRooms.get(who.path);
    if (starting) await starting.catch(() => undefined);
    const roomSession = pick((starting ? await liveSessions() : live).filter((x) => worksIn(x.realCwd, who.path) && x.id !== asker?.id), who.path);
    const name = roomName(who.path);
    let reached: string;
    if (roomSession) {
      const ok = await typeInto(roomSession, toRoom, false, () => undefined, true);
      // Nothing typed (its screen never came up): safe for the owner to try again.
      if (ok === 'later') throw Object.assign(new Error(`Couldn't get your answer into ${name}'s chat; try again, or open the room.`), { status: 503 });
      // Typed but not yet seen in its chat (a busy session takes it later): never typed twice.
      reached = ok ? `typed into ${name}'s own chat` : `typed into ${name}'s chat, though the office couldn't see it land yet (check the room in a minute)`;
    } else if (!wantsAction(ask, answer)) {
      reached = `not sent to ${name} (nobody in, and nothing to do)`;
    } else if (!isTrusted(who.path)) {
      // An untrusted folder can't start a session here (delegate would put up a trust button instead).
      reached = `NOT sent to ${name}: nobody is in and Claude Code doesn't trust that folder yet, so it's yours to hand on with delegate (its Trust and start button carries it)`;
    } else {
      // Nobody in: the room's session starts with their pick (the same hand-off as the manager's delegate).
      await startRoomWith(who.path, name, toRoom);
      reached = `started ${name}'s session with it`;
    }
    // The manager hears it too. Their copy can't undo the room's (The owner must never be asked twice), so any
    // failure here is only logged.
    const copy = `${answerLine(ask, answer)} [Office: their answer was also ${reached}${reached.startsWith('NOT') ? '.' : ', so the room acts on it itself: don\'t relay it or ask the room to wait for you.'} Update your notebook, and make it a job with a brief if it needs one.]`;
    try {
      const told = asker ? await typeInto(asker, copy, true, () => undefined, true) : await tellManager(copy);
      if (told !== true) console.error(`asks: the owner's answer reached ${name} but not the manager (${told})`);
    } catch (e) {
      console.error(`asks: the owner's answer reached ${name} but not the manager:`, e);
    }
    console.log(`asks: the owner ${'choice' in answer ? `chose "${ask.options?.[answer.choice]}" for` : `${'signIn' in answer ? 'said sign in yourself to' : `said ${yes ? 'yes' : 'no'} to`}`} "${ask.question}" (${reached})`);
    return;
  }
  // A "Trust and start" button, or a room question whose asker is gone: the answer goes to the manager.
  if ((ask.askedFor || ask.trust) && !asker) {
    const ok = await tellManager(`[Office: the owner answered a question that was over ${roomName(ask.folder)}'s head, but the session that asked has gone, so it came to you] ${answerLine(ask, answer)} Act on it now.`);
    if (ok !== true) throw Object.assign(new Error("Couldn't get your answer to the manager; try again."), { status: 503 });
    console.log(`asks: the owner's answer to "${ask.question}" went to the manager (the asker has gone)`);
    resumeJob(ask, answer); // a job riding on this button is back to work too
    return;
  }
  // Another answer may be starting this room's session right now: wait for it, then use that session.
  const inFlight = who ? startingRooms.get(who.path) : undefined;
  if (inFlight) await inFlight.catch(() => undefined);
  const nowLive = inFlight && who ? (await liveSessions()).filter((x) => worksIn(x.realCwd, who.path)) : live;
  const s = asker ?? (who ? pick(nowLive, who.path) : nowLive[0]);
  let ok: true | string | false | 'later' | undefined;
  if (s) ok = await typeInto(s, line, who?.id === 'manager', () => undefined, true);
  else if (who && who.id !== 'manager' && wantsAction(ask, answer) && isTrusted(who.path)) {
    // Nobody in the room: a yes or a real pick starts the room's session with the owner's answer, and the job's brief when there is one.
    const job = ask.job ?? ask.forJob;
    const task = job ? `${line}\n\nJob ${job}: read ${briefPath(MANAGER_NOTES_DIR, job)} first.` : line;
    await startRoomWith(who.path, roomName(who.path), task);
    ok = true;
    void tellManagerNow(`[Office: nobody was in ${roomName(ask.folder)}, so the office started its session with the owner's answer] ${line} Nothing for you to relay; update your notebook.`);
  } else {
    // Nobody in, and nothing the room can start on by itself (a no, "not yet", or a folder Claude Code
    // doesn't trust yet): the manager gets it, so the owner's answer is never dropped.
    ok = await tellManager(`[Office: nobody is in ${roomName(ask.folder)}, so the owner's answer came to you] ${line} ${wantsAction(ask, answer) ? 'Hand this to the room now (delegate; the folder needs trusting first).' : 'Note it; the room picks it up next time it is in.'}`);
  }
  if (ok !== true) throw Object.assign(new Error("Couldn't get your answer into their chat; try again, or open the room."), { status: 503 });
  resumeJob(ask, answer);
  console.log(`asks: the owner ${'choice' in answer ? `chose "${ask.options?.[answer.choice]}" for` : `${'signIn' in answer ? 'said sign in yourself to' : `said ${yes ? 'yes' : 'no'} to`}`} "${ask.question}"`);
}

// Open jobs: the owner's asks that aren't done. When a room's session has gone quiet
// on one, the office nudges it to carry on; if that stops helping, or there's no
// session at all, the manager hears about it. (Rules in src/team/jobs.ts.)
const JOBS = jobsPath(MANAGER_NOTES_DIR);
const DISMISSED = dismissedPath(MANAGER_NOTES_DIR);
const GOALS = goalsPath(MANAGER_NOTES_DIR);
// The goal the owner set for each room, by its folder (whiteboard and the manager's office list).
const boardGoals = (): Record<string, string> => Object.fromEntries(Object.entries(loadGoals(GOALS)).map(([k, v]) => [k, v.goal]));
// What the owner dismissed lately, so the whiteboard keeps them hidden.
function boardDismissed(): { room: string; text: string; job?: string; at: number }[] {
  return loadDismissed(DISMISSED).reverse(); // newest first
}
// The owner brought a dismissed item back: off the list, a closed job reopened, and the manager told.
async function boardBringBack(room: string, text: string): Promise<void> {
  const item = removeDismissed(DISMISSED, room, text);
  if (!item) throw Object.assign(new Error("That's not on the dismissed list any more."), { status: 404 });
  let job: Job | undefined;
  if (item.job) {
    saveJobs(JOBS, loadJobs(JOBS).map((j) => {
      if (j.id !== item.job || j.status !== 'done') return j;
      job = item.waitingFor
        ? { ...j, status: 'waiting' as const, waitingFor: item.waitingFor, updatedAt: Date.now(), lastNudge: undefined, nudgesToday: 0 }
        : { ...j, status: 'active' as const, updatedAt: Date.now(), lastNudge: Date.now(), nudgesToday: 0 };
      return job;
    }));
  }
  // It was waiting on the owner: their Approve button goes back over the room's head (as job wait does).
  if (job?.status === 'waiting') {
    let folder = job.room;
    try {
      folder = realpathSync(job.room);
    } catch {
      /* keep as written */
    }
    saveAsks(ASKS, addAsk(loadAsks(ASKS), folder, job.waitingFor ?? item.text, Date.now(), undefined, undefined, job.id));
  }
  const line = job
    ? job.status === 'waiting'
      ? `The owner: bring back job ${job.id} (${item.room}: ${item.text}). They had dismissed it on your whiteboard and have now undone that, so the office has reopened it, still waiting on them for: ${job.waitingFor}. Their Approve button is back over the room's head. Put it back in your notebook.`
      : `The owner: bring back job ${job.id} (${item.room}: ${item.text}). They had dismissed it on your whiteboard and have now undone that, so the office has reopened the job. Tell the room to carry on, and put it back in your notebook.`
    : `The owner: ${item.room}: ${item.text}. They had dismissed this on your whiteboard and has now brought it back, so it's fine to suggest it or action it again. It's off ${DISMISSED}.`;
  await tellManagerNow(line);
  console.log(`board: the owner brought back "${item.room}: ${item.text}"${job ? ` (job ${job.id} reopened)` : ''}`);
}
// A whiteboard click for the manager: typed into their chat now. If that can't happen, it is
// already saved where they look, so the click still counts.
async function tellManagerNow(line: string): Promise<void> {
  try {
    const manager = await theManager();
    const live = (await liveSessions()).find((x) => x.id === manager.id);
    if (!live || (await typeInto(live, line, true, () => undefined, true)) !== true) console.error('board: the manager not told now; they read it from', DISMISSED);
  } catch (err) {
    console.error('board: the manager not told now:', err);
  }
}
const JOB_CLI = join(MANAGER_DIR, 'job');
const roomName = (path: string): string => (floors.latest()?.rooms ?? []).find((r) => r.kind === 'project' && r.project && worksIn(path, r.project.path))?.name ?? path.split('/').pop() ?? path;
function boardJobs(): { id: string; room: string; title: string; done: string; status: string; waitingFor?: string; holdFor?: string; holdUntil?: number }[] {
  return loadJobs(JOBS)
    .filter((j) => j.status !== 'done')
    .map((j) => ({ id: j.id, room: roomName(j.room), title: j.title, done: j.done, status: j.status, ...(j.waitingFor ? { waitingFor: j.waitingFor } : {}), ...(isHeld(j, Date.now()) ? { holdFor: j.holdFor, holdUntil: j.holdUntil } : {}) }));
}
// The office's microphone: the page turns the owner's speech into text with the browser's own
// speech recognition (Claude Code's dictation can't reach the manager: macOS gives the microphone only
// to sessions inside the Claude Code app, and the manager runs outside it),
// and the words are typed into the manager's chat as the owner's own message.
const MAX_SAY = 4000;
async function say(text: string, from?: From): Promise<void> {
  const words = text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SAY);
  if (!words) throw Object.assign(new Error('Nothing was heard.'), { status: 400 });
  const g = await theManager();
  const live = (await liveSessions()).find((x) => x.id === g.id);
  if (!live) throw Object.assign(new Error("The manager's session isn't running yet; try again in a moment."), { status: 503 });
  const ok = await typeInto(live, `The owner (spoken, through the office mic${from ? `, ${fromWords(from)}` : ''}): ${words}`, true, () => undefined, true);
  if (ok !== true) throw Object.assign(new Error("Couldn't get your words into the manager's chat; try again."), { status: 503 });
  console.log('mic: the owner spoke to the manager');
}

// Goal steps (src/team/autonomy.ts): rooms with a goal work toward it on their own while
// the Claude allowance has room (src/team/budget.ts). Busy rooms (The owner's own, a job, an
// earlier step still going) take their places first.
const allowance = new Allowance(usageReader(config.usageCommand));
const STEPS = stepsPath(MANAGER_NOTES_DIR);
let lastPlan: Plan | undefined;
async function runGoals(): Promise<void> {
  void allowance.refresh();
  const goals = loadGoals(GOALS);
  const rooms = (floors.latest()?.rooms ?? []).filter((r) => r.kind === 'project' && r.project);
  const all = (await allSessions()).filter((s) => worksAlive(s.pid ?? 0));
  const jobs = loadJobs(JOBS).filter((j) => j.status !== 'done');
  const asks = loadAsks(ASKS);
  const now = Date.now();
  const busyIn = (path: string) =>
    all.some((s) => worksIn(s.realCwd, path) && (s.status === 'busy' || (s.state === 'blocked' && waitingOn(s.sessionId, s.cwd).kind !== 'unknown') || (terminals.forSession(s.id)?.viewers() ?? 0) > 0));
  // Working now: a busy session anywhere on the floor, or an active job (not held, not waiting on the owner).
  const working = new Set([...rooms.filter((r) => busyIn(r.project!.path)).map((r) => r.project!.path), ...jobs.filter((j) => j.status === 'active' && !isHeld(j, now)).map((j) => j.room)]);
  lastPlan = plan(allowance.latest(), now, working.size, undefined, config.usageCommand ? undefined : config.goalRooms);
  if (lastPlan.free < 1) return;
  const cands: Candidate[] = rooms
    .filter((r) => goals[r.project!.path])
    .map((r) => ({
      room: r.project!.path,
      goal: goals[r.project!.path]!.goal,
      hasJob: jobs.some((j) => worksIn(real(j.room), r.project!.path)),
      hasAsk: asks.some((a) => worksIn(real(a.folder), r.project!.path)),
      busy: busyIn(r.project!.path),
    }));
  const pick = pickRoom(cands, loadSteps(STEPS, now - 86_400_000), now);
  if (!pick) return;
  const room = rooms.find((r) => r.project!.path === pick.room)!;
  const line = stepLine(pick.goal, lastPlan.why, join(MANAGER_DIR, 'ask'));
  const here = all.filter((s) => worksIn(s.realCwd, pick.room) && s.kind !== 'interactive').sort((a, b) => lastActiveAt(b) - lastActiveAt(a))[0];
  if (here) {
    const ok = await typeInto(here, line, false);
    if (ok === 'later') return; // nothing typed: try again next minute
    // Typed (even if not yet seen in its chat): counts as its step, so it's never typed twice.
    logStep(STEPS, { room: pick.room, at: Date.now(), how: 'typed' });
  } else {
    // No session there: the same hand-off the manager's delegate does (the room's model and brief).
    const env = { ...(await userEnv()), CM_CLAUDE_BIN: CLAUDE_BIN, CM_DATA_DIR: DATA_DIR };
    // Logged before the start: a start that errors after the session is up must not start another.
    logStep(STEPS, { room: pick.room, at: Date.now(), how: 'started' });
    const ok = await new Promise<boolean>((resolve) =>
      execFile(join(MANAGER_DIR, 'delegate'), [pick.room, room.name, line], { env, timeout: 60_000 }, (err, _o, stderr) => {
        if (err) console.error(`goal step for ${room.name} didn't start:`, String(stderr || err.message).slice(0, 200));
        resolve(!err);
      }),
    );
    liveCache = undefined;
    if (!ok) return;
  }
  console.log(`goal step: ${room.name} works on "${pick.goal}" (${lastPlan.why})`);
}

// Every question put to the owner, once (for the scorecard): asks.json only holds open ones.
const ASKS_LOG = join(MANAGER_NOTES_DIR, 'asks.jsonl');
const askSeen = new Set(jsonl<{ id: string }>(ASKS_LOG).map((a) => a.id));
function logAsks(): void {
  for (const a of loadAsks(ASKS)) {
    if (askSeen.has(a.id)) continue;
    askSeen.add(a.id);
    try {
      appendFileSync(ASKS_LOG, JSON.stringify({ id: a.id, at: a.createdAt, folder: a.folder }) + '\n', { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }
}

let scoreCache: { at: number; lines: string[] } | undefined;
function scorecard(): string[] {
  if (scoreCache && Date.now() - scoreCache.at < 5 * 60_000) return scoreCache.lines;
  const lines = describeScore(
    score({ jobs: loadJobs(JOBS), asksLog: ASKS_LOG, checksLog: CHECKS_LOG, stepsLog: STEPS, managerDir: join(homedir(), '.claude', 'projects', real(MANAGER_DIR).replace(/[^a-zA-Z0-9]/g, '-')), now: Date.now() }),
  );
  scoreCache = { at: Date.now(), lines };
  return lines;
}
const autonomyLine = () => `Working on their own: ${lastPlan ? lastPlan.why : 'not worked out yet'}`;

// A question the owner answered by typing in the asker's own chat (not on the button): the button
// goes, and a job waiting on it is back to work, so no out-of-date question lingers over a room.
// Only the asker's own questions: one manager put over a room (ask --room) or a trust button stays.
const chatSeen = new Map<string, number>(); // ask id -> transcript size last read: re-read only when it grew
async function clearAnsweredInChat(): Promise<void> {
  // Not the manager's own buttons: the owner talks to them about everything, so a line in the manager's chat is
  // rarely the answer (a passing "wait, has 1.5 been released…" would take down unrelated questions).
  // A job's own button (job wait) has no session: every chat in its room counts, worktrees too
  // (otherwise a button stays up after the owner talked to the room in a worktree session).
  const asks = loadAsks(ASKS).filter((a) => !a.askedFor && !a.trust && !worksIn(a.folder, MANAGER_DIR) && (a.sessionId || a.job));
  for (const key of chatSeen.keys()) if (!asks.some((a) => key.startsWith(`${a.id}:`))) chatSeen.delete(key);
  if (!asks.length) return;
  const all = await allSessions();
  const gone: Ask[] = [];
  for (const a of asks) {
    const chats = a.sessionId ? all.filter((x) => x.sessionId === a.sessionId) : all.filter((x) => x.sessionId && worksIn(x.realCwd, a.folder));
    for (const s of chats) {
      const file = join(homedir(), '.claude', 'projects', s.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${s.sessionId}.jsonl`);
      const key = `${a.id}:${s.sessionId}`;
      let tail = '';
      try {
        const fd = openSync(file, 'r');
        try {
          const size = fstatSync(fd).size;
          const seen = chatSeen.get(key);
          if (seen === size) continue; // nothing new in that chat
          chatSeen.set(key, size);
          // Everything new since the last look (the whole chat the first time, up to 32 MB), with a
          // little overlap so a line cut at the last look is read whole. Only the last 512 KB was read
          // before: the owner's line in a long, busy chat could be further back.
          const from = seen === undefined || seen > size ? Math.max(0, size - 32 * 1024 * 1024) : Math.max(0, seen - 64 * 1024);
          const buf = Buffer.alloc(size - from);
          readSync(fd, buf, 0, size - from, from);
          tail = buf.toString('utf8');
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const said = typedLinesSince(tail.split('\n'), a.createdAt).find((t) => answersAsk(t, a));
      if (said) {
        gone.push(a);
        console.log(`asks: the owner answered "${a.question.slice(0, 80)}" in ${roomName(a.folder)}'s chat ("${said.slice(0, 60)}"); its button is gone`);
        break;
      }
    }
  }
  if (!gone.length) return;
  const ids = new Set(gone.map((a) => a.id));
  saveAsks(ASKS, loadAsks(ASKS).filter((a) => !ids.has(a.id)));
  // The room's own question a waiting job rides on: any answer puts the job back to work (as a click
  // would). A job's own Approve button (job wait) is different: their typed reply may be a "no", so that
  // job stays waiting and the room, which read their words, moves it on itself (job go).
  const resume = new Set(gone.map((a) => a.forJob).filter((x): x is string => !!x));
  if (resume.size)
    saveJobs(JOBS, loadJobs(JOBS).map((j: Job) => {
      if (!resume.has(j.id) || j.status !== 'waiting') return j;
      const { waitingFor: _w, ...back } = j;
      return { ...back, status: 'active' as const, updatedAt: Date.now(), lastNudge: Date.now(), nudgesToday: 0 };
    }));
}

async function runJobs(): Promise<void> {
  const jobs = loadJobs(JOBS).filter((j) => j.status !== 'done');
  if (!jobs.length) return;
  const all = (await allSessions()).filter((s) => worksAlive(s.pid ?? 0));
  const openAsks = loadAsks(ASKS);
  const riding = new Set(openAsks.map((a) => a.forJob).filter(Boolean)); // waiting jobs whose room's own question is still up
  // A room with a "Trust and start" button up is waiting on the owner's tap, which starts its session with
  // the task: no "no session" reports or nudges until then.
  const trustPending = (room: string) => openAsks.some((a) => a.trust && worksIn(real(a.folder), room));
  for (const job of jobs) {
    const now = Date.now();
    const here = all.filter((s) => worksIn(s.realCwd, job.room)).sort((a, b) => Number(b.status === 'busy') - Number(a.status === 'busy') || lastActiveAt(b) - lastActiveAt(a));
    const s = here[0];
    const room = s && { status: s.status, state: here.some((x) => x.state === 'blocked' && waitingOn(x.sessionId, x.cwd).kind !== 'unknown') ? 'blocked' : 'idle', lastActive: Math.max(...here.map((x) => lastActiveAt(x))), viewed: here.some((x) => (terminals.forSession(x.id)?.viewers() ?? 0) > 0) };
    if (!room && trustPending(job.room)) continue;
    const d = decide(job, room, now, riding.has(job.id));
    if (d === 'none') continue;
    const name = roomName(job.room);
    const ok =
      d === 'check'
        ? s
          ? await typeInto(s, checkLine(job, JOB_CLI, briefPath(MANAGER_NOTES_DIR, job.id)), false)
          : await tellManager(checkLine(job, JOB_CLI, briefPath(MANAGER_NOTES_DIR, job.id)).replace('tell the manager in one line', 'tell the room'))
        : d === 'nudge'
        ? await typeInto(s!, nudgeLine(job, JOB_CLI, briefPath(MANAGER_NOTES_DIR, job.id)), false)
        : d === 'no-session'
          ? await tellManager(`[Office: job "${job.title}" (${job.id}) has no session running in ${name}] Hand it to the room now (delegate, or SendMessage if a session appears), with the done line: ${job.done}`)
          : await tellManager(`[Office: job "${job.title}" (${job.id}) is stuck in ${name}] Nudged ${job.nudgesToday} times today and still not done. Read the room's last action on your status page and send the room its next step. Only if it truly needs the owner, tell them the one thing in one line.`);
    if (ok === 'later') continue;
    if (!ok) console.error(`jobs: "${job.title}" ${d} didn't land`);
    else console.log(`jobs: ${d} for "${job.title}" (${name})`);
    saveJobs(JOBS, loadJobs(JOBS).map((j: Job) => (j.id === job.id ? nudged(j, d, now) : j)));
  }
}

// Rooms send reports to one fixed address, kept in a file the room brief points at. It's the live
// The manager's socket (uds:/tmp/cc-socks/<pid>.sock), which SendMessage takes as-is: their `claude agents`
// id isn't something SendMessage resolves, so with an offline Remote Control "Manager" also listed,
// rooms couldn't reach it and asked the owner which manager to use.
function writeManagerAddress(address: string): void {
  try {
    mkdirSync(MANAGER_NOTES_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(MANAGER_NOTES_DIR, 'manager-address.txt'), `${address}\n`);
  } catch (err) {
    console.error("could not write the manager's address:", err);
  }
}

async function retireExtraManagers(keepId: string): Promise<void> {
  try {
    const all = await allSessions();
    writeManagerAddress(managerAddress(all.find((s) => s.id === keepId)?.pid));
    // Every listed session, not just running ones: a stale blocked "Manager" counts too.
    for (const id of extraManagers(all, MANAGER_DIR, keepId)) {
      await stopSession(id);
      terminals.forSession(id)?.close(); // no viewer left watching a stopped manager
      console.log(`stopped a second manager (${id}); kept ${keepId}`);
    }
  } catch (err) {
    console.error('could not tidy up extra managers:', err);
  }
}

// One session per room (like one manager): once a newer session starts in a room,
// the older ones are stopped when they're idle. The new one picks the work up
// from project memory and the latest office skill. Never stops a session
// that's working, waiting on the owner, being watched, holding an open question,
// or that finished a reply in the last few minutes.
async function retireExtraRoomSessions(): Promise<void> {
  const now = Date.now();
  const all = (await allSessions()).filter((s) => worksAlive(s.pid ?? 0));
  const asking = new Set(loadAsks(ASKS).map((a) => a.sessionId).filter(Boolean));
  for (const r of floors.latest()?.rooms ?? []) {
    if (r.kind !== 'project' || !r.project) continue;
    const hold = (s: (typeof all)[number]) =>
      (terminals.forSession(s.id)?.viewers() ?? 0) > 0 ||
      asking.has(s.sessionId) ||
      now - lastActiveAt(s) < 3 * 60_000 ||
      (s.state === 'blocked' && waitingOn(s.sessionId, s.cwd).kind !== 'unknown');
    for (const id of extraRoomSessions(all, r.project.path, hold)) {
      try {
        await stopSession(id);
        terminals.forSession(id)?.close();
        liveCache = undefined;
        console.log(`one session per room: stopped an older session (${id}) in ${r.name}`);
      } catch (err) {
        console.error(`could not stop an older session in ${r.name}:`, err);
      }
    }
  }
}

// New office happenings from Haiku, about once a day; alongside the tick, never blocking it.
const GAGS = join(DATA_DIR, 'happenings.json');
// The coffee room (src/team/coffee.ts): a few times a day, 2-3 rooms share what they learned.

let coffeeBusy = false;
function coffeeBreak(): void {
  if (coffeeBusy || !config.extras.coffee) return;
  const s = loadCoffee(DATA_DIR);
  if (!breakDue(s, new Date())) return;
  const u = allowance.latest();
  // With no usage meter, the gentle default pace (as if a quarter of the week were used).
  const gap = config.usageCommand ? nextGap(u?.weekly?.usedPercent, u?.session?.usedPercent) : nextGap(25, 0);
  if (gap === undefined) return; // allowance tight or not read yet: look again next tick
  const rooms = (floors.latest()?.rooms ?? [])
    .filter((r) => r.kind === 'project' && r.project && r.lead)
    .map((r) => ({ id: `lead:${r.id}`, name: r.name, activity: r.project!.activity, notes: recentNotes(r.project!.path) }))
    .filter((r) => r.notes.length);
  // The next break is set before brewing, so a failure waits its turn instead of retrying every tick.
  saveCoffee(DATA_DIR, { ...s, next: Date.now() + gap });
  if (rooms.length < 2) return;
  const chosen = pickRooms(rooms);
  coffeeBusy = true;
  void userEnv()
    .then((env) => brewChat(coffeePrompt(chosen, s.tips, s.removed), { claude: CLAUDE_BIN, cwd: join(DATA_DIR, 'coffee', 'brew'), env }))
    .then((out) => {
      const cur = loadCoffee(DATA_DIR);
      const r = parseCoffee(out, chosen.map((c) => c.name), (room) => chosen.find((c) => c.name === room)?.notes ?? [], cur.tips.map((t) => t.id));
      if (!r) throw new Error(`no usable chat: ${out.slice(0, 160)}`);
      const now = Date.now();
      const who = r.chat.map((c) => ({ id: chosen.find((x) => x.name === c.room)!.id, name: c.room, line: c.line }));
      saveCoffee(DATA_DIR, { ...applyBreak(cur, r, now), last: { at: now, who } });
      console.log(`coffee: ${who.map((w) => w.name).join(', ')} had a break; ${r.tips.length} new tips, ${r.same.length} confirmed`);
    })
    .catch((err) => console.error('coffee:', String(err).slice(0, 200)))
    .finally(() => (coffeeBusy = false));
}

// The weekly tidy of the coffee board: merges rewordings, drops what newer notes contradict.
function coffeeTidy(): void {
  if (coffeeBusy || !config.extras.coffee) return;
  const s = loadCoffee(DATA_DIR);
  if (!tidyDue(s, Date.now())) return;
  const u = allowance.latest();
  if (config.usageCommand && nextGap(u?.weekly?.usedPercent, u?.session?.usedPercent) === undefined) return;
  const rooms = (floors.latest()?.rooms ?? []).filter((r) => r.kind === 'project' && r.project);
  const named = [...new Set(s.tips.flatMap((t) => t.from.split(', ')))];
  const notes = named.map((room) => ({ room, notes: recentNotes(rooms.find((r) => r.name === room)?.project!.path ?? '', 3, 900) }));
  coffeeBusy = true;
  saveCoffee(DATA_DIR, { ...s, tidiedAt: Date.now() }); // one try a week, even if it fails
  void userEnv()
    .then((env) => brewChat(tidyPrompt(s.tips, notes), { claude: CLAUDE_BIN, cwd: join(DATA_DIR, 'coffee', 'brew'), env }))
    .then((out) => {
      const cur = loadCoffee(DATA_DIR);
      const r = applyTidy(cur, out, Date.now());
      if (!r) throw new Error(`tidy unusable or too drastic: ${out.slice(0, 160)}`);
      saveCoffee(DATA_DIR, r.state);
      console.log(`coffee: weekly tidy, ${cur.tips.length} tips -> ${r.state.tips.length}${r.dropped.length ? `; dropped: ${r.dropped.map((d) => d.why).join('; ')}` : ''}`);
    })
    .catch((err) => console.error('coffee:', String(err).slice(0, 200)))
    .finally(() => (coffeeBusy = false));
}

let gagsBusy = false;
let gagsHeldUntil = 0;
function freshGags(): void {
  if (gagsBusy || !config.extras.happenings || Date.now() < gagsHeldUntil) return;
  const f = loadGags(GAGS);
  if (!gagsDue(f)) return;
  gagsBusy = true;
  void userEnv()
    .then((env) => writeGags(f, { claude: CLAUDE_BIN, cwd: join(DATA_DIR, 'gags'), env }))
    .then((fresh) => {
      const next = addGags(loadGags(GAGS), fresh);
      saveGags(GAGS, next);
      console.log(`happenings: Haiku wrote ${fresh.length} new ones (${next.gags.length} in the pool)`);
    })
    .catch((err) => {
      console.error('happenings:', String(err).slice(0, 200));
      try {
        saveGags(GAGS, { ...loadGags(GAGS), at: Date.now(), ok: false });
      } catch {
        gagsHeldUntil = Date.now() + 6 * 60 * 60_000; // can't even note the failure: wait anyway
      }
    })
    .finally(() => (gagsBusy = false));
}

// Last line of defence: log and keep running rather than crash-loop under launchd.
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

// The office log has project names and questions in it: only the owner reads it.
try {
  chmodSync(join(homedir(), 'Library', 'Logs', 'tiny-hq.log'), 0o600);
} catch {
  /* no log yet */
}
server.listen(port, '127.0.0.1', () => {
  // Only the office that owns the port keeps the manager warm: a second copy (say,
  // started while launchd was restarting this one) must not start a manager of its own.
  if (!process.env.CM_NO_WARM) {
    void warmManager();
    // One at a time: the timetable, then open jobs (both may type into the manager).
    let ticking = false;
    const tick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        await runSchedule();
        await runJobs();
        await runGoals();
        logAsks();
        await clearAnsweredInChat();
        await retireExtraRoomSessions();
        await tellGithub();
        freshGags();
        coffeeBreak();
        coffeeTidy();
        if (!ghBusy && config.extras.github) {
          ghBusy = true;
          void lookGithub()
            .catch((err) => console.error('github:', err))
            .finally(() => (ghBusy = false));
        }
      } catch (err) {
        console.error('timetable/jobs:', err);
      } finally {
        ticking = false;
      }
    };
    setTimeout(() => void tick(), 20_000); // after the manager is warm
    setInterval(() => void tick(), 60_000).unref();
    setTimeout(() => void writeStatus(), 25_000);
    setInterval(() => void writeStatus(), 60_000).unref();
  }
  // The token itself is never printed: logs and process lists are not private.
  console.log(`tiny-hq on http://127.0.0.1:${port} (token in ${TOKEN_PATH})`);
  if (config.remote) console.log(`Tailscale door on 127.0.0.1:${port + 1} for https://${config.remote.host} (point tailscale serve here)`);
  console.log('Open the office with: tiny-hq open');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    terminals.closeAll(); // detach only; the sessions keep running
    server.close();
    process.exit(0);
  });
}
