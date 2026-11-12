import type { Room } from '../../src/office/layout.ts';
import { Api, AuthError, forgetToken, isRemote, takeToken } from './api.ts';
import { Office, ago } from './office.ts';
import { TerminalPanel } from './terminal.ts';
import { Board } from './board.ts';
import { Timetable } from './timetable.ts';
import { Desk } from './desk.ts';
import { renderUsage, wireMic } from './topbar.ts';
import { startHappenings, type Gag } from './whimsy.ts';
import { Sound, wireSoundSwitch } from './sound.ts';
import { darker, lookFor, paintCanvas, personPixels } from './sprites.ts';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const MANAGER_LINES = (owner: string): string[] => [
  `Morning, ${owner}. Let's circle back on everything.`,
  'Whiteboard is clean. For now. It knows what it did.',
  'Mug is full. Synergy is high. The plant is cautiously optimistic.',
  `Door is open, ${owner}. Metaphorically. The actual door is shy.`,
  `Welcome back, ${owner}. The coffee machine has prepared a short presentation.`,
];

// The locked door. Over Tailscale it explains pairing (a new phone, or one
// that was forgotten or not used for 30 days).
function showLocked(): void {
  if (isRemote()) {
    $('locked-how').textContent = "This device isn't paired (or was forgotten). On the Mac, in ~/.tiny-hq/app, make a pairing link and open it here within 10 minutes:";
    $('locked-cmd').textContent = 'tiny-hq pair';
  }
  $('locked').classList.remove('hidden');
}

async function start(): Promise<void> {
  const token = await takeToken();
  if (!token) return showLocked();
  const api = new Api(token);
  const office = new Office();
  const terminal = new TerminalPanel(api, () => requestAnimationFrame(() => office.relayout()));
  // Each tab wears its person's colour from the floor (The manager's blue, each lead's shirt).
  terminal.colourFor = (path) => {
    const f = office.current;
    if (!f) return undefined;
    if (path === managerPath) return f.agents.find((a) => a.id === 'manager')?.palette.shirt;
    return f.rooms.find((r) => r.project?.path === path)?.lead?.palette.shirt;
  };
  const card = $('card');
  let managerPath = '';
  let sessions: Record<string, 'busy' | 'idle'> = {};
  let waiting: Record<string, { kind: string; text: string }> = {}; // blocked rooms: what they wait on

  // The room card: who works here, what they're doing, which model, and the way in.
  function showCard(room: Room): void {
    card.replaceChildren();
    const el = (tag: string, cls = '', text = '') => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const x = el('button', 'card-x', '×') as HTMLButtonElement;
    x.title = 'Close';
    x.onclick = () => card.classList.add('hidden');
    card.append(x);
    if (room.kind === 'archive') {
      card.append(el('h2', '', room.name), el('p', 'card-quip', `${room.count} quieter projects are filed here. They get a room when they get busy again.`));
      card.classList.remove('hidden');
      return;
    }
    if (room.kind === 'lounge') {
      card.append(el('h2', '', room.name), el('p', 'card-quip', 'Nobody has a job in here. Everyone is welcome, the coffee is free, and the manager is always "just popping in".'));
      card.classList.remove('hidden');
      return;
    }
    const isManager = room.kind === 'manager';
    const id = isManager ? 'manager' : `lead:${room.id}`;
    const who = isManager ? { name: managerName(), personality: 'Runs the office: hands out the jobs, keeps the whiteboard, and reports back.', palette: { skin: '#e8b48f', hair: '#6b4a2f', shirt: '#3f6fb5' } } : room.lead;
    // Header: their face, their name, and where they work.
    const head = el('div', 'card-head');
    const face = document.createElement('canvas');
    face.width = 36;
    face.height = 48;
    face.className = 'card-face';
    if (who) paintCanvas(face, personPixels(who.palette, isManager ? '#d8443c' : darker(who.palette.shirt), 'idle', lookFor(isManager ? 'Manager' : who.name)));
    const title = el('div', 'card-title');
    title.append(el('h2', '', who?.name ?? room.name), el('div', 'card-where', isManager ? 'Manager · the whole office' : `${room.name} · ${shortPath(room.project?.path ?? '')}`));
    head.append(face, title);
    card.append(head);
    if (who?.personality) card.append(el('p', 'card-quip', who.personality));
    // What they're up to right now.
    const st = sessions[id];
    const wait = waiting[id];
    const chip = el(
      'div',
      `card-status ${wait ? 'blocked' : (st ?? 'off')}`,
      wait ? `Blocked, waiting for you: ${wait.text}` : st === 'busy' ? 'Working now' : st === 'idle' ? 'At their desk, waiting for you' : 'Not in yet: opening the room starts them',
    );
    card.append(chip);
    if (room.project) {
      const pr = room.project;
      const facts = [pr.language, `${pr.recentSessions} chats this month`, `active ${ago(pr.lastActive)}`].filter(Boolean).join(' · ');
      const meta = el('div', 'card-meta', facts);
      const gh = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pr.remote ?? '');
      if (gh) {
        const a = el('a', '', 'GitHub ↗') as HTMLAnchorElement;
        a.href = `https://github.com/${gh[1]}`;
        a.target = '_blank';
        a.rel = 'noopener';
        meta.append(document.createTextNode(' · '), a);
      }
      card.append(meta);
    }
    // Which model their Claude runs on.
    const modelRow = el('div', 'card-models');
    modelRow.append(el('span', 'card-label', 'Model'));
    const note = el('div', 'card-note');
    if (isManager) modelRow.append(el('span', 'seg on pinned', 'Opus · pinned'));
    else {
      const current = room.model ?? 'opus';
      for (const m of ['opus', 'sonnet', 'haiku'] as const) {
        const b = el('button', `seg${m === current ? ' on' : ''}`, m[0]!.toUpperCase() + m.slice(1)) as HTMLButtonElement;
        b.onclick = async () => {
          for (const o of modelRow.querySelectorAll('.seg')) o.classList.toggle('on', o === b);
          note.textContent = 'Telling them…';
          const r = await api.setModel(room.project!.path, m);
          if ('error' in r) note.textContent = r.error;
          else {
            room.model = m;
            office.setModel(id, m);
            note.textContent = r.applied === 'now' ? `Switched: they're on ${b.textContent} now.` : st === 'busy' ? `They're mid-task: ${b.textContent} from their next conversation.` : `Their next conversation starts on ${b.textContent}.`;
          }
        };
        modelRow.append(b);
      }
    }
    card.append(modelRow, note);
    // The way in.
    const actions = el('div', 'row');
    const path = isManager ? managerPath : room.project!.path;
    const label = isManager ? `Talk to ${managerName()}` : 'Open Claude';
    const open = el('button', '', label) as HTMLButtonElement;
    open.onclick = () => {
      card.classList.add('hidden');
      void terminal.open(path, isManager ? managerName() : `${who?.name.split(' ')[0] ?? room.name} · ${room.name}`);
    };
    const fresh = el('button', 'ghost', 'New conversation') as HTMLButtonElement;
    fresh.onclick = () => {
      card.classList.add('hidden');
      void terminal.open(path, isManager ? managerName() : `${who?.name.split(' ')[0] ?? room.name} · ${room.name}`, 'new');
    };
    actions.append(open, fresh);
    card.append(actions);
    card.classList.remove('hidden');
  }

  // ~/Dev/x instead of /Users/owner/Dev/x.
  const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

  // The manager's name, as the owner chose it in setup.
  const managerName = () => office.current?.names?.manager ?? 'Manager';

  // Who a person id is, as the owner sees them on the floor.
  const nameOf = (id: string): string => {
    if (id === 'manager') return managerName();
    const room = office.current?.rooms.find((r) => `lead:${r.id}` === id);
    return room?.lead?.name.split(' ')[0] ?? room?.name ?? id;
  };

  const handlers = {
    onRoom: (room: Room) => showCard(room),
    onManager: () => {
      const room = office.current?.rooms.find((r) => r.kind === 'manager');
      if (room) showCard(room);
    },
    onBoard: () => {
      card.classList.add('hidden');
      void api.board().then((notes) => board.show(office.current, sessions, notes));
    },
    onTimetable: () => {
      card.classList.add('hidden');
      void timetable.show();
    },
    onDesk: () => {
      card.classList.add('hidden');
      void desk.show();
    },
    onCoffee: () => {
      card.classList.add('hidden');
      void api.coffee().then((b) => {
        if ('error' in b) return desk.showPage('Coffee room board', b.error, '');
        const when = b.lastAt ? `last break ${ago(b.lastAt)}` : 'no break yet';
        desk.showBoard(`${b.tips} tips · ${when} · × removes one for good`, b.list ?? [], (id) => api.coffeeRemove(id));
      });
    },
    onEmpty: () => card.classList.add('hidden'),
  };
  const board = new Board();
  board.onAction = async (room, next) => {
    const r = await api.boardAction(room, next);
    return 'error' in r ? r.error : null;
  };
  board.onDismiss = async (room, text, job) => {
    const r = await api.boardDismiss(room, text, job);
    return 'error' in r ? r.error : null;
  };
  board.onGoal = async (folder, goal) => {
    const r = await api.boardGoal(folder, goal);
    return 'error' in r ? r.error : null;
  };
  board.onBringBack = async (room, text) => {
    const r = await api.boardDismiss(room, text, undefined, true);
    return 'error' in r ? r.error : null;
  };
  const timetable = new Timetable(api);
  const desk = new Desk(api);
  desk.onRead = () => void pollOnce().catch(() => undefined);

  await office.mount($('floor'), handlers);
  // A link straight to a report (…/#desk=<id>, e.g. from the manager on the phone) opens it.
  const deskLink = /(?:^#|&)desk=([a-z0-9]{8,16})/.exec(location.hash)?.[1];
  if (deskLink) void desk.open(deskLink);

  async function load(refresh: boolean): Promise<void> {
    $('status').textContent = refresh ? 'Re-scanning projects…' : 'Taking the register…';
    const floor = await api.floor(refresh);
    managerPath = (floor as typeof floor & { managerPath?: string }).managerPath ?? '';
    office.render(floor, handlers);
    terminal.renderTabs(); // colours come from the floor
    office.showSessions(sessions);
    const projects = floor.rooms.filter((r) => r.kind === 'project').length;
    const archived = floor.rooms.find((r) => r.kind === 'archive')?.count ?? 0;
    $('status').textContent = `${projects} project rooms${archived ? ` · ${archived} in the archive` : ''} · scanned ${ago(floor.generatedAt)}`;
  }

  // Who's working: checked while the page is open and visible, never in the background.
  // The manager's latest reply goes in their speech bubble once, when it's new.
  const heard: Record<string, string> = {};
  let firstPoll = true;
  // Office sounds: quiet chimes for news, questions and finished jobs (src: sound.ts).
  const sound = new Sound();
  wireSoundSwitch($('sound') as HTMLButtonElement, sound);
  const asksSeen = new Set<string>(); // every question ever seen: one that comes back never chimes twice
  let lastDone = 0; // the latest job finish seen
  // Back from a hidden tab: catch up silently (what changed meanwhile may be hours old).
  let quietCatchUp = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) quietCatchUp = true;
  });
  let polling = false;
  async function poll(): Promise<void> {
    if (document.hidden || polling) return; // never stack checks if the Mac is slow to answer
    polling = true;
    try {
      await pollOnce();
    } finally {
      polling = false;
    }
  }
  let coffeeSeen = 0;
  async function pollOnce(): Promise<void> {
    const r = await api.sessions().catch((err: unknown) => {
      if (err instanceof AuthError) throw err;
      return null;
    });
    if (!r) return;
    sessions = r.sessions;
    waiting = r.waiting;
    office.showSessions(sessions);
    office.showDesk(r.deskUnread);
    // A coffee break that started in the last 10 minutes and hasn't been shown yet: they walk over.
    if (r.coffee && r.coffee.at !== coffeeSeen) {
      if (Date.now() - r.coffee.at < 10 * 60_000) office.coffeeBreak(r.coffee.who, new Date(r.coffee.at).toISOString());
      coffeeSeen = r.coffee.at;
    }
    // Someone needs the owner's yes: Approve / No over their head.
    office.showAsks(r.asks, async (askId, answer) => {
      const res = await api.answer(askId, answer);
      return 'error' in res ? res.error : null;
    });
    // A sound for what's new since the last look: a question over a news chime, a finished job over both.
    const askIds = Object.values(r.asks ?? {}).map((a) => a.id);
    // Stopped on a permission prompt in their room: a hand over their head until it's answered.
    const newlyBlocked = office.showBlocked(Object.fromEntries(Object.entries(waiting).map(([id, w]) => [id, w.text])));
    const newQuestion = askIds.some((id) => !asksSeen.has(id)) || newlyBlocked.length > 0;
    for (const id of askIds) asksSeen.add(id);
    const newDone = !firstPoll && !!r.lastDone && r.lastDone > lastDone;
    if (r.lastDone && r.lastDone > lastDone) lastDone = r.lastDone;
    let newNews = false;
    for (const [id, line] of Object.entries(r.said)) {
      if (heard[id] === line.at) continue;
      if (!firstPoll) newNews = true;
      heard[id] = line.at;
      if (firstPoll) {
        // Page just opened: a "!" over whoever has something the owner hasn't read.
        office.update(id, line.text, line.at);
        continue;
      }
      // Sent to someone on the floor: they walk over with it.
      if (line.to) office.deliver(id, line.to, line.text, line.at);
      else office.heard(id, line.text, line.at);
      terminal.activity(`${nameOf(id)}: ${line.text}`);
    }
    if (firstPoll || quietCatchUp) {
      // The first look, or the first after a hidden spell: everything here is old news.
      sound.arm();
      quietCatchUp = false;
    } else if (newDone) sound.play('done');
    else if (newQuestion) sound.play('question');
    else if (newNews) sound.play('message');
    firstPoll = false;
    // A "…" over whoever is working right now.
    office.keepBubbles(sessions);
    // While a terminal covers the floor, its header says who's working.
    const working = Object.entries(sessions).filter(([, st]) => st === 'busy').map(([id]) => nameOf(id));
    terminal.working(working);
  }

  $('refresh').addEventListener('click', () => void load(true).catch(fail));
  // The usage board, re-read every minute (the office reads the usage meter every 5).
  const usage = () => void api.usage().then((m) => renderUsage($('usage'), m));
  usage();
  setInterval(usage, 60_000);
  // The one microphone: the browser turns speech into text, and the words go to the manager.
  wireMic($('mic') as HTMLButtonElement, (text) => api.say(text), (text) => ($('status').textContent = text), (on) => sound.play(on ? 'micOn' : 'micOff'));
  window.addEventListener('resize', () => office.fit());
  await load(false);
  terminal.restore(); // back in the session the owner was last in
  const lines = MANAGER_LINES(office.current?.names?.owner ?? 'friend');
  office.say(lines[Math.floor(Math.random() * lines.length)]!, 6000);
  void poll().catch(fail);
  setInterval(() => void poll().catch(fail), 5_000);
  // Little happenings on the floor, never over anything real; Haiku's written ones re-read hourly.
  let gags: Gag[] = [];
  const readGags = () => void api.gags().then((g) => (gags = g));
  readGags();
  setInterval(readGags, 60 * 60_000);
  startHappenings({
    cast: () => office.cast(),
    gags: () => gags,
    // About every other happening gets its little boing.
    happen: (h) => {
      const shown = office.happen(h.id, h.text, h.prop, h.anim);
      if (shown && Math.random() < 0.5) sound.play('whimsy');
      return shown;
    },
    isFree: (id) => office.isFree(id),
  });
  document.addEventListener('visibilitychange', () => void poll().catch(fail));
}

function fail(err: unknown): void {
  const msg = String((err as Error)?.message ?? err);
  $('status').textContent = `Something went wrong: ${msg}`;
  if (err instanceof AuthError) {
    forgetToken();
    showLocked();
  }
}

start().catch(fail);
