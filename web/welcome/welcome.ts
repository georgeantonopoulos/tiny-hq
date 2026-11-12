// The welcome page: a few friendly steps, then "Open my office". The setup server
// (src/cli/welcome.ts) suggests the answers and saves them; this page only asks.

type Style = 'calm' | 'whimsical' | 'plain';
interface Choices {
  officeName: string;
  ownerName: string;
  managerName: string;
  managerStyle: Style;
  projectRoots: string[];
  extras: { github: boolean; coffee: boolean; happenings: boolean };
  briefing: boolean;
  phone: boolean;
  login: boolean;
  hooks: string[];
  skill: boolean;
}
interface Item { id: string; title: string; what: string }
interface Welcome { choices: Choices; roots: string[]; styles: Style[]; extras: Item[]; helpers: Item[]; gh: boolean }
interface Room { path: string; name: string; where: string; lastActive: number; recent: number; repo?: string; chosen: boolean }

const MAX_ROOMS = 12; // the floor holds 12 rooms; more picks wait in the archive cupboard
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG = 'http://www.w3.org/2000/svg';

// The one-time key from the link; then it's taken out of the address bar.
const key = new URLSearchParams(location.hash.slice(1)).get('key') ?? '';
history.replaceState(null, '', location.pathname);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Something went wrong (${r.status}).`);
  return body;
}

const GREETING: Record<Style, (owner: string) => [string, string]> = {
  calm: (o) => [`Hi ${o}. I'll keep things steady`, 'and tell you only what matters.'],
  whimsical: (o) => [`Ahoy, ${o}! Kettle's on and the`, "whiteboard's sparkling. Shall we?"],
  plain: (o) => [`Hello ${o}. I hand out the jobs`, 'and report back. Short and clear.'],
};
const STYLE_NOTE: Record<Style, string> = {
  calm: 'Warm and unhurried. Says what matters, nothing more.',
  whimsical: 'Cheerful, with a little office humour. Still gets it done.',
  plain: 'Straight to the point. Short updates, no chit-chat.',
};

let data: Welcome;
let rooms: Room[] = [];
let roomsLoaded = false; // without the list, room picks are left as they were
const picked = new Set<string>();
let step = 0;
const LAST = 6;

// ---- The office front (an SVG drawn in little blocks) ----
function el(tag: string, attrs: Record<string, string | number>, parent: Element, text?: string): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function drawFront(): void {
  const root = $('front') as unknown as SVGSVGElement;
  root.replaceChildren();
  const c = data.choices;
  // The street, then the building on it (shifted right to leave room for the speech bubble).
  el('rect', { x: 0, y: 124, width: 380, height: 8, fill: '#3a3346' }, root);
  el('rect', { x: 0, y: 122, width: 380, height: 2, fill: '#4b4259' }, root);
  const svg = el('g', { transform: 'translate(20 0)' }, root) as unknown as SVGSVGElement;
  el('rect', { x: 20, y: 22, width: 280, height: 100, fill: '#8a5a44' }, svg);
  for (let y = 26; y < 122; y += 8) for (let x = 20 + ((y / 8) % 2) * 6; x < 296; x += 12) el('rect', { x, y, width: 10, height: 1, fill: '#7a4d3a' }, svg);
  el('rect', { x: 14, y: 14, width: 292, height: 10, fill: '#4a3f5c' }, svg);
  el('rect', { x: 14, y: 22, width: 292, height: 2, fill: '#2f2840' }, svg);
  // The sign over the door.
  el('rect', { x: 104, y: 28, width: 112, height: 18, fill: '#b07e1f' }, svg);
  el('rect', { x: 106, y: 30, width: 108, height: 14, fill: '#f2b544' }, svg);
  el('text', { x: 160, y: 40, 'text-anchor': 'middle', class: 'sign-text' }, svg, fit(c.officeName || 'Tiny HQ', 20));
  // Windows: one per room, lit for each project picked.
  const lit = Math.min(picked.size, MAX_ROOMS);
  const spots: [number, number][] = [];
  for (const row of [54, 78]) for (const x of [38, 64, 90, 206, 232, 258]) spots.push([x, row]);
  spots.forEach(([x, y], i) => {
    el('rect', { x: x - 2, y: y - 2, width: 24, height: 20, fill: '#5c3a2c' }, svg);
    el('rect', { x, y, width: 20, height: 16, fill: i < lit ? '#ffd36b' : '#2a3550', class: 'lit' }, svg);
    el('rect', { x: x + 9, y, width: 2, height: 16, fill: '#5c3a2c' }, svg);
    if (i < lit) el('rect', { x: x + 2, y: y + 2, width: 4, height: 2, fill: '#fff3c4' }, svg);
  });
  // The door.
  el('rect', { x: 144, y: 80, width: 32, height: 42, fill: '#3b2a22' }, svg);
  el('rect', { x: 147, y: 83, width: 26, height: 39, fill: '#3f6fb5' }, svg);
  el('rect', { x: 150, y: 87, width: 20, height: 12, fill: '#9cc3ff' }, svg);
  el('rect', { x: 167, y: 103, width: 3, height: 3, fill: '#f2b544' }, svg);
  // Plants.
  for (const x of [128, 184]) {
    el('rect', { x, y: 114, width: 10, height: 8, fill: '#a0522d' }, svg);
    el('rect', { x: x - 1, y: 106, width: 12, height: 8, fill: '#4f9a5b' }, svg);
    el('rect', { x: x + 2, y: 102, width: 6, height: 5, fill: '#6cc18a' }, svg);
  }
  // The manager, from step 2 on, by the door with a speech bubble.
  if (step >= 2) drawManager(svg, 196, 94, c);
}

function drawManager(svg: SVGSVGElement, x: number, y: number, c: Choices): void {
  const skin = '#e8b48f', hair = '#6b4a2f', shirt = '#3f6fb5', legs = '#2f2840';
  el('rect', { x: x + 2, y, width: 8, height: 3, fill: hair }, svg);
  el('rect', { x: x + 2, y: y + 3, width: 8, height: 7, fill: skin }, svg);
  el('rect', { x: x + 4, y: y + 5, width: 1, height: 1, fill: '#2a2534' }, svg);
  el('rect', { x: x + 7, y: y + 5, width: 1, height: 1, fill: '#2a2534' }, svg);
  el('rect', { x, y: y + 10, width: 12, height: 10, fill: shirt }, svg);
  el('rect', { x: x + 2, y: y + 20, width: 3, height: 8, fill: legs }, svg);
  el('rect', { x: x + 7, y: y + 20, width: 3, height: 8, fill: legs }, svg);
  if (c.managerStyle === 'whimsical') {
    el('polygon', { points: `${x + 3},${y} ${x + 9},${y} ${x + 6},${y - 7}`, fill: '#e2574c' }, svg);
    el('rect', { x: x + 5, y: y - 9, width: 2, height: 2, fill: '#f2b544' }, svg);
  } else if (c.managerStyle === 'calm') {
    el('rect', { x: x + 12, y: y + 12, width: 4, height: 4, fill: '#f4efe7' }, svg);
    el('rect', { x: x + 16, y: y + 13, width: 1, height: 2, fill: '#f4efe7' }, svg);
  } else {
    el('rect', { x: x + 11, y: y + 11, width: 5, height: 7, fill: '#c58b4a' }, svg);
    el('rect', { x: x + 12, y: y + 13, width: 3, height: 4, fill: '#fff' }, svg);
  }
  // Name tag.
  const name = fit(c.managerName || 'Manager', 12);
  const w = Math.max(24, name.length * 3.6 + 6);
  el('rect', { x: x + 6 - w / 2, y: y + 29, width: w, height: 8, fill: '#d8443c', rx: 1 }, svg);
  el('text', { x: x + 6, y: y + 35, 'text-anchor': 'middle', class: 'tag-text' }, svg, name);
  // Speech bubble, to the right.
  const [a, b] = GREETING[c.managerStyle](fit(c.ownerName || 'friend', 10));
  el('rect', { x: x + 20, y: y - 26, width: 122, height: 24, fill: '#fff', rx: 3 }, svg);
  el('polygon', { points: `${x + 22},${y - 3} ${x + 30},${y - 3} ${x + 16},${y + 4}`, fill: '#fff' }, svg);
  el('text', { x: x + 25, y: y - 16, class: 'bubble-text' }, svg, a);
  el('text', { x: x + 25, y: y - 7, class: 'bubble-text' }, svg, b);
}

const fit = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- Steps ----
function show(n: number): void {
  step = n;
  document.querySelectorAll<HTMLElement>('.step').forEach((s) => s.classList.toggle('on', Number(s.dataset.step) === n));
  document.querySelectorAll<HTMLElement>('#steps li').forEach((li, i) => {
    li.classList.toggle('done', i < n);
    li.classList.toggle('now', i === n);
    li.setAttribute('aria-current', i === n ? 'step' : 'false');
  });
  $('back').hidden = n === 0;
  $('next').textContent = n === 0 ? "Let's go" : n === LAST ? 'Open my office' : 'Next';
  if (n === LAST) renderSummary();
  drawFront();
  const first = document.querySelector<HTMLElement>(`.step.on input:not([type=search]), .step.on .style-card[aria-checked=true]`);
  first?.focus({ preventScroll: true });
}

function buildSteps(): void {
  const list = $('steps');
  document.querySelectorAll<HTMLElement>('.step').forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.dataset.label ?? '';
    list.appendChild(li);
  });
}

// ---- Names and manager ----
function bindText(id: keyof Choices): void {
  const input = $<HTMLInputElement>(id);
  input.value = String(data.choices[id] ?? '');
  input.addEventListener('input', () => {
    (data.choices[id] as string) = input.value.trim();
    drawFront();
  });
}

function buildStyles(): void {
  const grid = $('styles');
  grid.setAttribute('role', 'radiogroup');
  for (const s of data.styles) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'style-card';
    b.setAttribute('role', 'radio');
    const strong = document.createElement('strong');
    strong.textContent = s;
    const em = document.createElement('em');
    em.textContent = STYLE_NOTE[s];
    b.append(strong, em);
    b.addEventListener('click', () => {
      data.choices.managerStyle = s;
      markStyles();
      drawFront();
    });
    grid.appendChild(b);
  }
  markStyles();
}
const markStyles = () => document.querySelectorAll<HTMLElement>('.style-card').forEach((b, i) => b.setAttribute('aria-checked', String(data.styles[i] === data.choices.managerStyle)));

// ---- Rooms ----
const ago = (t: number) => {
  if (!t) return 'not used yet';
  const d = Math.floor((Date.now() - t) / 86_400_000);
  return d <= 0 ? 'used today' : d === 1 ? 'used yesterday' : d < 30 ? `used ${d} days ago` : d < 365 ? `used ${Math.round(d / 30)} months ago` : 'used over a year ago';
};

async function loadRooms(roots?: string[]): Promise<void> {
  $('rooms').replaceChildren(loading());
  $('rooms-sub').textContent = 'Looking around for your projects…';
  try {
    const q = roots ? `?roots=${encodeURIComponent(roots.join('\n'))}` : '';
    const r = await call<{ rooms: Room[] }>(`/api/welcome/rooms${q}`);
    const before = new Set(picked);
    const known = new Set(rooms.map((x) => x.path));
    rooms = r.rooms;
    picked.clear();
    for (const room of rooms) if (roots && known.has(room.path) ? before.has(room.path) : room.chosen) picked.add(room.path);
    roomsLoaded = true;
    renderRooms();
  } catch (err) {
    $('rooms-sub').textContent = err instanceof Error ? err.message : String(err);
  }
}

function loading(): HTMLElement {
  const d = document.createElement('div');
  d.className = 'loading';
  d.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  return d;
}

function renderRooms(): void {
  const q = $<HTMLInputElement>('room-filter').value.trim().toLowerCase();
  const box = $('rooms');
  box.replaceChildren();
  const shown = rooms.filter((r) => !q || r.name.toLowerCase().includes(q) || r.where.toLowerCase().includes(q) || (r.repo ?? '').toLowerCase().includes(q));
  for (const r of shown) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'room';
    b.setAttribute('role', 'checkbox');
    b.setAttribute('aria-checked', String(picked.has(r.path)));
    const tick = document.createElement('span');
    tick.className = 'box';
    const txt = document.createElement('span');
    txt.className = 'txt';
    const name = document.createElement('strong');
    name.textContent = r.name;
    const where = document.createElement('small');
    where.textContent = `${r.where} · ${ago(r.lastActive)}`;
    txt.append(name, where);
    if (r.recent > 0) {
      const busy = document.createElement('small');
      busy.className = 'busy';
      busy.textContent = `${r.recent} Claude chat${r.recent === 1 ? '' : 's'} this month`;
      txt.appendChild(busy);
    }
    b.append(tick, txt);
    b.addEventListener('click', () => {
      if (picked.has(r.path)) picked.delete(r.path);
      else picked.add(r.path);
      b.setAttribute('aria-checked', String(picked.has(r.path)));
      roomsCount();
      drawFront();
    });
    box.appendChild(b);
  }
  if (!rooms.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = "No projects found yet. Tell us where they live below, or carry on: rooms appear by themselves as you use Claude Code.";
    box.appendChild(e);
  } else if (!shown.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing matches that.';
    box.appendChild(e);
  }
  roomsCount();
  drawFront();
}

function roomsCount(): void {
  const n = picked.size;
  const extra = n > MAX_ROOMS ? ` The office holds ${MAX_ROOMS} rooms, so the quietest ${n - MAX_ROOMS} wait in the archive cupboard.` : '';
  $('rooms-sub').textContent = rooms.length
    ? `${n} of ${rooms.length} picked. The ones you leave out go in the archive cupboard, where you can fetch them any time.${extra}`
    : '';
}

// ---- Switches ----
function toggle(item: Item, on: boolean, set: (v: boolean) => void, opts: { badge?: string; disabled?: string } = {}): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'toggle';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  const txt = document.createElement('span');
  txt.className = 'txt';
  const t = document.createElement('strong');
  t.textContent = item.title;
  if (opts.badge) {
    const bd = document.createElement('span');
    bd.className = 'badge';
    bd.textContent = opts.badge;
    t.appendChild(bd);
  }
  const w = document.createElement('small');
  w.textContent = item.what;
  txt.append(t, w);
  if (opts.disabled) {
    const n = document.createElement('small');
    n.className = 'note';
    n.textContent = opts.disabled;
    txt.appendChild(n);
  }
  const sw = document.createElement('span');
  sw.className = 'switch';
  b.append(txt, sw);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(v));
    set(v);
  });
  return b;
}

function buildToggles(): void {
  const c = data.choices;
  const ex = $('extras');
  for (const item of data.extras) {
    const get = () => (item.id === 'briefing' ? c.briefing : item.id === 'login' ? c.login : c.extras[item.id as keyof Choices['extras']]);
    const set = (v: boolean) => {
      if (item.id === 'briefing') c.briefing = v;
      else if (item.id === 'login') c.login = v;
      else c.extras[item.id as keyof Choices['extras']] = v;
    };
    const note = item.id === 'github' && !data.gh ? 'Needs GitHub\'s "gh" tool signed in on this Mac. You can switch it on now; it starts once gh is there.' : undefined;
    ex.appendChild(toggle(item, get(), set, note ? { disabled: note } : {}));
  }
  const hp = $('helpers');
  for (const item of data.helpers) {
    const get = () => (item.id === 'skill' ? c.skill : c.hooks.includes(item.id));
    const set = (v: boolean) => {
      if (item.id === 'skill') c.skill = v;
      else c.hooks = v ? [...new Set([...c.hooks, item.id])] : c.hooks.filter((h) => h !== item.id);
    };
    hp.appendChild(toggle(item, get(), set, { badge: 'Recommended' }));
  }
}

// ---- Summary and finish ----
function renderSummary(): void {
  const c = data.choices;
  const names = rooms.filter((r) => picked.has(r.path)).map((r) => r.name);
  const on = data.extras.filter((x) => (x.id === 'briefing' ? c.briefing : x.id === 'login' ? c.login : c.extras[x.id as keyof Choices['extras']])).map((x) => x.title);
  const helpers = data.helpers.filter((h) => (h.id === 'skill' ? c.skill : c.hooks.includes(h.id))).length;
  const rows: [string, string][] = [
    ['Office', c.officeName || 'Tiny HQ'],
    ['You', c.ownerName || 'Owner'],
    ['Manager', `${c.managerName || 'Manager'}, ${c.managerStyle}`],
    ['Rooms', names.length ? `${names.length}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? `, and ${names.length - 6} more` : ''}` : 'none yet; they appear as you use Claude Code'],
    ['Extras', on.length ? on.join(', ') : 'none'],
    ['Helpers', `${helpers} of ${data.helpers.length}`],
  ];
  const ul = $('summary');
  ul.replaceChildren();
  for (const [k, v] of rows) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = k;
    const s = document.createElement('span');
    s.textContent = v;
    li.append(b, s);
    ul.appendChild(li);
  }
  $('ready-title').textContent = `Ready to move in, ${c.ownerName || 'friend'}`;
}

async function finish(): Promise<void> {
  const err = $('error');
  err.hidden = true;
  $<HTMLButtonElement>('next').disabled = true;
  $('moving').classList.remove('hidden');
  const lines = ['Moving in…', 'Hanging the sign…', 'Setting up the desks…', `${data.choices.managerName || 'Your manager'} is putting the kettle on…`];
  let i = 0;
  const tick = setInterval(() => ($('moving-text').textContent = lines[++i % lines.length]!), 1600);
  try {
    const r = await call<{ url?: string; error?: string }>('/api/welcome/finish', {
      method: 'POST',
      body: JSON.stringify({ ...data.choices, ...(roomsLoaded ? { rooms: { chosen: [...picked] } } : {}) }),
    });
    if (!r.url) throw new Error(r.error ?? 'The office did not open.');
    $('moving-text').textContent = 'Welcome in!';
    location.href = r.url;
  } catch (e) {
    clearInterval(tick);
    $('moving').classList.add('hidden');
    err.textContent = e instanceof Error ? e.message : String(e);
    err.hidden = false;
    $<HTMLButtonElement>('next').disabled = false;
  }
}

// ---- Start ----
async function start(): Promise<void> {
  buildSteps();
  try {
    data = await call<Welcome>('/api/welcome');
  } catch (e) {
    document.querySelector('.card')!.replaceChildren(Object.assign(document.createElement('p'), { className: 'error', textContent: e instanceof Error ? e.message : String(e) }));
    return;
  }
  for (const id of ['officeName', 'ownerName', 'managerName'] as const) bindText(id);
  buildStyles();
  buildToggles();
  $<HTMLTextAreaElement>('roots').value = data.roots.join('\n');
  $('room-filter').addEventListener('input', renderRooms);
  $('room-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault(); // searching, not moving on
  });
  $('rooms-all').addEventListener('click', () => {
    for (const r of rooms) picked.add(r.path);
    renderRooms();
  });
  $('rooms-none').addEventListener('click', () => {
    picked.clear();
    renderRooms();
  });
  $('rescan').addEventListener('click', () => {
    const roots = $<HTMLTextAreaElement>('roots').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (roots.length) data.choices.projectRoots = roots;
    void loadRooms(roots);
  });
  $('back').addEventListener('click', () => show(Math.max(0, step - 1)));
  $('card').addEventListener('submit', (e) => {
    e.preventDefault();
    if (step === LAST) void finish();
    else show(step + 1);
  });
  void loadRooms();
  show(0);
}

void start();
