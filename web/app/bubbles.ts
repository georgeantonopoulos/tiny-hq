// What people on the floor have for the owner, as page elements on top of the office
// canvas (readable at any zoom, nothing in a room can cover them).
//
// Over each head, a marker:
//   ?  they need the owner to answer something: tap it for the question, with Approve / No
//      or, for a multiple-choice question, one button per option.
//   !  they said something new: tap it to read the whole message in a bubble that
//      scrolls inside itself when it's long. Once read, the marker goes until they
//      say something new (the whole conversation is in their room).
//   ✋ their Claude is stopped on a permission prompt (or its own question) in their room:
//      tap it to open the room and answer there (otherwise only the room card says so).
//   …  they're working right now (dots like a typing indicator): tap to open their room.
// One bubble is open at a time; × or tapping the empty floor closes it. What the owner
// has read is remembered on this device, so a "!" doesn't come back after a reload.
//
// Short passing lines (The manager's hello when the page opens) still pop up by themselves
// and go after a few seconds.

export interface Speaker {
  id: string;
  name: string;
  role: string; // room or job, shown next to the name
  colour: string; // name tag colour (their shirt)
  // Where the top of their head is now, in floor pixels, or null if not drawn;
  // `foot`: just below them, where a bubble goes when there's no room above.
  anchor(): { x: number; y: number; foot?: number } | null;
}

export interface AskInfo {
  id: string;
  question: string;
  tried?: string; // what the asker already tried (every button for the owner says it)
  more?: number; // further questions from them, waiting their turn
  options?: string[]; // multiple choice; otherwise Approve / No
  post?: string; // a public post's exact text: Approve lets only this go up, once
  target?: string; // where it goes (owner/repo#N, owner/repo, a page): Approve is for there only
  password?: boolean; // a sign-in only the owner can do: Done, I did it / You sign in (saved passkey or password manager) / No
}

export type Answer = { yes: boolean } | { choice: number } | { signIn: true };

interface Person {
  speaker: Speaker;
  line?: { text: string; at: string };
  ask?: AskInfo;
  blocked?: string; // what their session is stopped on, waiting for the owner in the room
  running: boolean;
  working: boolean; // their session is busy right now
  mark: HTMLDivElement;
  shape: string; // what the marker shows now, to skip rebuilding it every poll
}

interface Panel {
  id: string;
  mode: 'msg' | 'ask';
  el: HTMLDivElement;
  key: string; // the line's time or the ask's id it shows
}

interface Flash {
  el: HTMLDivElement;
  text: HTMLSpanElement;
  full: string;
  shown: number;
  until: number;
  speaker: Speaker;
}

const READ_KEY = 'cm-read'; // person id -> time of the line the owner read
const OLD_DISMISSED_KEY = 'cm-bubbles-dismissed'; // before markers: person id -> the line they closed
const CHARS_PER_SEC = 55;
const MAX_MESSAGE = 6000;

export class Bubbles {
  onAnswer?: (askId: string, answer: Answer) => Promise<string | null>; // null: done; string: what went wrong

  private readonly host: HTMLElement;
  private readonly people = new Map<string, Person>();
  private readonly flashes = new Map<string, Flash>();
  private panel?: Panel;
  private readonly answered = new Set<string>(); // question ids the owner answered here
  private readonly onTap: (id: string) => void;
  private readonly read: Record<string, string> = load(READ_KEY);
  private readonly oldDismissed: Record<string, string> = load(OLD_DISMISSED_KEY);

  constructor(floor: HTMLElement, onTap: (id: string) => void) {
    this.host = document.createElement('div');
    this.host.className = 'bubbles';
    floor.append(this.host);
    this.onTap = onTap;
  }

  // ---- Their latest message ----

  // Has the owner read this line of theirs (on this device)?
  isRead(id: string, text: string, at: string): boolean {
    if (this.read[id] === at) return true;
    // Closed in the old bubbles (kept as their 260-character version): counts as read.
    const old = this.oldDismissed[id];
    if (old === undefined) return false;
    const plain = tidy(text);
    return old === (plain.length > 260 ? `${plain.slice(0, 259)}…` : plain);
  }

  // Their latest message. New ones get a "!" until the owner opens them.
  update(speaker: Speaker, text: string, at: string): void {
    const p = this.person(speaker);
    if (p.line?.at === at && p.line.text === text) return;
    this.endHappening(speaker.id);
    p.line = { text, at };
    p.running = true;
    // Open on them already: it's in front of the owner, so it's read.
    if (this.panel?.id === speaker.id && this.panel.mode === 'msg') this.openMessage(speaker.id);
    this.refreshMark(p, true);
  }

  // Who has a session running now (kept for the open bubble's sake). An unread
  // message or an open question stays until the owner has seen it, session or not.
  setRunning(running: Set<string>): void {
    for (const [id, p] of this.people) {
      p.running = running.has(id);
      this.refreshMark(p);
      if (!this.wanted(p)) this.forget(id);
    }
  }

  // Who is working right now: a "…" over them while they are.
  setWorking(working: Speaker[]): void {
    const ids = new Set(working.map((s) => s.id));
    for (const s of working) {
      const p = this.person(s);
      if (!p.working) {
        this.endHappening(s.id);
        p.working = true;
        this.refreshMark(p);
      }
    }
    for (const [id, p] of this.people) {
      if (ids.has(id) || !p.working) continue;
      p.working = false;
      this.refreshMark(p);
      if (!this.wanted(p)) this.forget(id);
    }
  }

  // Who is stopped on a permission prompt (or Claude's own question), by id: what it waits on.
  // Returns the ids that are newly blocked, for a chime.
  setBlocked(blocked: Record<string, string>, speakerOf: (id: string) => Speaker | undefined): string[] {
    const fresh: string[] = [];
    for (const [id, text] of Object.entries(blocked)) {
      const s = speakerOf(id);
      if (!s) continue;
      const p = this.person(s);
      if (p.blocked === text) continue;
      if (p.blocked === undefined) fresh.push(id);
      this.endHappening(id);
      p.blocked = text;
      this.refreshMark(p, true);
    }
    for (const [id, p] of this.people) {
      if (p.blocked === undefined || id in blocked) continue;
      p.blocked = undefined;
      this.refreshMark(p);
      if (!this.wanted(p)) this.forget(id);
    }
    return fresh;
  }

  // ---- Questions for the owner ----

  ask(speaker: Speaker, ask: AskInfo): void {
    // Answered from this page: a check that left before the answer landed can still list it. Ignore that.
    if (this.answered.has(ask.id)) return;
    const p = this.person(speaker);
    const same = p.ask && p.ask.id === ask.id && p.ask.question === ask.question && p.ask.more === ask.more && (p.ask.options ?? []).join('\n') === (ask.options ?? []).join('\n') && p.ask.tried === ask.tried && p.ask.password === ask.password && p.ask.post === ask.post && p.ask.target === ask.target;
    if (same) return;
    this.endHappening(speaker.id);
    const isNew = p.ask?.id !== ask.id;
    p.ask = ask;
    if (this.panel?.id === speaker.id && this.panel.mode === 'ask' && this.panel.key !== ask.id) {
      // A different question replaced the one on screen: show the new one (unless they're mid-answer).
      // The same one coming back (a failed answer put it back) keeps its card and its error note.
      if (!this.panel.el.classList.contains('busy')) this.openAsk(speaker.id);
    }
    this.refreshMark(p, isNew);
  }

  clearAsk(id: string): void {
    const p = this.people.get(id);
    if (!p?.ask) return;
    p.ask = undefined;
    if (this.panel?.id === id && this.panel.mode === 'ask' && !this.panel.el.classList.contains('busy')) this.close();
    this.refreshMark(p);
    if (!this.wanted(p)) this.forget(id);
  }

  askIds(): string[] {
    return [...this.people].filter(([, p]) => p.ask).map(([id]) => id);
  }

  // ---- Short passing lines (a hello): pop up, type out, go ----

  // Real news for someone: a whimsical happening over them steps aside at once.
  private endHappening(id: string): void {
    const f = this.flashes.get(id);
    if (!f || !f.el.classList.contains('happening')) return;
    f.el.remove();
    this.flashes.delete(id);
  }

  // Free for a passing happening (src: whimsy.ts): nothing real is showing over them or open
  // on the floor (no question, no unread message, not working, no line already up).
  isFree(id: string): boolean {
    if (this.panel || this.flashes.has(id)) return false;
    const p = this.people.get(id);
    return !p || (!p.ask && !p.blocked && !p.working && !(p.line && !this.isRead(id, p.line.text, p.line.at)));
  }

  // `happening`: a whimsical moment from the floor, told by a narrator (italic, no name tag),
  // so it never reads like something the person really said.
  say(speaker: Speaker, raw: string, ms = 6000, happening = false): void {
    const full = tidy(raw).slice(0, 260);
    if (!full) return;
    let f = this.flashes.get(speaker.id);
    if (f && f.el.classList.contains('happening') !== happening) {
      f.el.remove();
      this.flashes.delete(speaker.id);
      f = undefined;
    }
    if (!f) {
      const el = document.createElement('div');
      el.className = `bubble flash${speaker.id === 'manager' ? ' manager' : ''}${happening ? ' happening' : ''}`;
      const text = document.createElement('span');
      text.className = 'said';
      if (happening) el.append(text);
      else el.append(nameTag(speaker), text);
      el.addEventListener('click', () => this.onTap(speaker.id));
      this.host.append(el);
      f = { el, text, full, shown: 0, until: 0, speaker };
      this.flashes.set(speaker.id, f);
    }
    f.speaker = speaker;
    f.full = full;
    f.shown = 0;
    f.until = performance.now() + ms;
    f.el.classList.remove('leaving');
  }

  // ---- The open bubble ----

  close(): void {
    if (!this.panel) return;
    const id = this.panel.id;
    this.panel.el.remove();
    this.panel = undefined;
    const p = this.people.get(id);
    if (p) {
      this.refreshMark(p);
      if (!this.wanted(p)) this.forget(id);
    }
  }

  private openMessage(id: string): void {
    const p = this.people.get(id);
    if (!p?.line) return;
    const el = this.panelShell(p, p.speaker.name);
    el.classList.add('msg');
    const body = document.createElement('div');
    body.className = 'said scroll';
    body.textContent = readable(p.line.text);
    el.append(body);
    const keep = this.panel?.id === id && this.panel.mode === 'msg' ? this.panel.el.querySelector('.scroll')?.scrollTop : undefined;
    this.show({ id, mode: 'msg', el, key: p.line.at });
    if (keep !== undefined) body.scrollTop = keep; // the same bubble refreshed: don't jump to the top
    this.read[id] = p.line.at;
    delete this.oldDismissed[id];
    save(READ_KEY, this.read);
    save(OLD_DISMISSED_KEY, this.oldDismissed);
    this.refreshMark(p);
  }

  private openAsk(id: string): void {
    const p = this.people.get(id);
    const ask = p?.ask;
    if (!p || !ask) return;
    const el = this.panelShell(p, `${p.speaker.name} asks`);
    el.classList.add('ask');
    const q = document.createElement('div');
    q.className = 'q scroll';
    q.textContent = ask.question;
    if (ask.post) {
      // The exact words that would go public: what they approve is exactly this.
      const label = document.createElement('small');
      label.className = 'tried';
      label.textContent = ask.target
        ? `Exact text to post on ${ask.target} (Approve lets only this go up, once, only there):`
        : 'Exact text to post (no place named, so Approve lets it go up nowhere; the room must ask again with --target):';
      const body = document.createElement('blockquote');
      body.className = 'post-text';
      body.textContent = ask.post;
      q.append(document.createElement('br'), label, body);
    }
    if (ask.tried) {
      const t = document.createElement('small');
      t.className = 'tried';
      t.textContent = `Already tried: ${ask.tried}`;
      q.append(document.createElement('br'), t);
    }
    const row = document.createElement('div');
    row.className = ask.options ? 'ask-row choices' : 'ask-row';
    const note = document.createElement('small');
    note.className = 'note';
    if (ask.more) note.textContent = `${ask.more} more question${ask.more === 1 ? '' : 's'} from ${p.speaker.name} after this one`;
    const answer = async (a: Answer) => {
      if (!this.onAnswer || el.classList.contains('busy')) return;
      el.classList.add('busy');
      for (const x of row.querySelectorAll('button')) (x as HTMLButtonElement).disabled = true;
      note.textContent = 'Telling them…';
      const err = await this.onAnswer(ask.id, a);
      el.classList.remove('busy');
      if (err) {
        note.textContent = err;
        for (const x of row.querySelectorAll('button')) (x as HTMLButtonElement).disabled = false;
        return;
      }
      // Answered: the question goes (the next one, if any, arrives with the next check).
      this.answered.add(ask.id);
      if (p.ask?.id === ask.id) p.ask = undefined;
      if (this.panel?.el === el) this.close();
      else {
        this.refreshMark(p);
        if (!this.wanted(p)) this.forget(id);
      }
    };
    const btn = (label: string, cls: string, a: Answer) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        void answer(a);
      });
      return b;
    };
    if (ask.options) ask.options.forEach((o, i) => row.append(btn(o, 'pick', { choice: i })));
    else if (ask.password) {
      // Approve could read as "go ahead, type my password", so these say what the click means.
      const how = document.createElement('small');
      how.className = 'tried';
      how.textContent = 'Do this yourself, then press Done. Away from the Mac? "You sign in" lets them use only a saved passkey or password manager.';
      q.append(document.createElement('br'), how);
      row.append(btn('Done, I did it', 'yes', { yes: true }), btn('You sign in', 'pick', { signIn: true }), btn('No', 'no', { yes: false }));
    } else row.append(btn('Approve', 'yes', { yes: true }), btn('No', 'no', { yes: false }));
    el.append(q, row, note);
    this.show({ id, mode: 'ask', el, key: ask.id });
  }

  private panelShell(p: Person, title: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `bubble open${p.speaker.id === 'manager' ? ' manager' : ''}`;
    const head = document.createElement('div');
    head.className = 'head';
    const tag = nameTag(p.speaker, title);
    tag.title = `Open ${p.speaker.name}'s ${p.speaker.id === 'manager' ? 'office' : 'room'}`;
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onTap(p.speaker.id);
    });
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    head.append(tag, x);
    el.append(head);
    // Clicks inside the bubble stay in it (selecting text, scrolling).
    el.addEventListener('click', (e) => e.stopPropagation());
    return el;
  }

  private show(panel: Panel): void {
    const prev = this.panel;
    this.panel = panel;
    this.host.append(panel.el);
    if (prev) {
      prev.el.remove();
      if (prev.id !== panel.id) {
        const p = this.people.get(prev.id);
        if (p) {
          this.refreshMark(p);
          if (!this.wanted(p)) this.forget(prev.id);
        }
      }
    }
    const p = this.people.get(panel.id);
    if (p) this.refreshMark(p);
  }

  // ---- Markers ----

  private person(speaker: Speaker): Person {
    let p = this.people.get(speaker.id);
    if (!p) {
      const mark = document.createElement('div');
      mark.className = 'mark';
      this.host.append(mark);
      p = { speaker, running: true, working: false, mark, shape: '' };
      this.people.set(speaker.id, p);
    }
    p.speaker = speaker;
    return p;
  }

  private wanted(p: Person): boolean {
    return !!p.ask || !!p.blocked || p.working || (!!p.line && !this.isRead(p.speaker.id, p.line.text, p.line.at)) || this.panel?.id === p.speaker.id;
  }

  private forget(id: string): void {
    const p = this.people.get(id);
    if (!p || this.panel?.id === id) return;
    p.mark.remove();
    this.people.delete(id);
  }

  // Rebuild the marker when what it shows changes; `pop`: something new, so it bounces in.
  private refreshMark(p: Person, pop = false): void {
    const id = p.speaker.id;
    const unread = !!p.line && !this.isRead(id, p.line.text, p.line.at);
    const badges: ('wait' | 'q' | 'new' | 'work')[] = [];
    if (p.blocked) badges.push('wait');
    if (p.ask) badges.push('q');
    if (unread) badges.push('new');
    if (p.working) badges.push('work');
    const shape = badges.join(' ') + (p.blocked ? `|${p.blocked}` : '');
    if (shape !== p.shape) {
      p.shape = shape;
      const kids = badges.map((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `badge ${b}`;
        if (b === 'work') btn.append(...[0, 1, 2].map(() => document.createElement('i'))); // three bouncing dots
        else btn.textContent = b === 'wait' ? '✋' : b === 'q' ? '?' : '!';
        const label = b === 'wait' ? `${p.speaker.name} is waiting for your OK (${p.blocked}): open their room` : b === 'q' ? `${p.speaker.name} has a question for you` : b === 'new' ? `New from ${p.speaker.name}: read it` : `${p.speaker.name} is working: open their room`;
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (b === 'work' || b === 'wait') return this.onTap(id);
          const mode = b === 'q' ? 'ask' : 'msg';
          if (this.panel?.id === id && this.panel.mode === mode) return this.close(); // tap again: close
          if (mode === 'ask') this.openAsk(id);
          else this.openMessage(id);
        });
        return btn;
      });
      p.mark.replaceChildren(...kids);
    }
    if (pop && (p.ask || unread || p.blocked)) {
      p.mark.classList.remove('pop');
      void p.mark.offsetWidth; // restart the animation
      p.mark.classList.add('pop');
    }
  }

  // ---- Every frame: follow people, type passing lines, tidy up ----

  tick(dtMs: number): void {
    const now = performance.now();
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    for (const [id, f] of this.flashes) {
      if (now > f.until) {
        if (!f.el.classList.contains('leaving')) {
          f.el.classList.add('leaving');
          setTimeout(() => {
            if (this.flashes.get(id) === f && performance.now() > f.until) {
              f.el.remove();
              this.flashes.delete(id);
            }
          }, 250);
        }
      } else if (f.shown < f.full.length) {
        f.shown = Math.min(f.full.length, f.shown + Math.max(1, (CHARS_PER_SEC * dtMs) / 1000));
        f.text.textContent = f.full.slice(0, Math.floor(f.shown));
      }
      this.place(f.el, f.speaker, W, H);
    }
    for (const [id, p] of this.people) {
      // Hidden while their bubble is open, or while a passing line of theirs is up.
      const covered = this.panel?.id === id || (this.flashes.has(id) && !this.flashes.get(id)!.el.classList.contains('leaving'));
      if (!p.shape || covered) {
        p.mark.style.visibility = 'hidden';
        continue;
      }
      this.place(p.mark, p.speaker, W, H, 12, false);
    }
    if (this.panel) {
      const p = this.people.get(this.panel.id);
      if (p) this.place(this.panel.el, p.speaker, W, H);
    }
  }

  // Above the head, kept inside the floor; a bubble's tail points at the speaker.
  private place(el: HTMLElement, speaker: Speaker, W: number, H: number, gap = 12, tail = true): void {
    const a = speaker.anchor();
    // A marker only shows over someone in view (an open bubble is kept on screen instead).
    if (!a || (!tail && (a.x < 0 || a.x > W || a.y < 0 || a.y > H))) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.visibility = '';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(6, Math.min(W - w - 6, a.x - w / 2));
    // No room above them: hang the bubble below them (tail on top) rather than over their face.
    const below = tail && a.y - h - gap < 6 && a.foot !== undefined && a.foot + gap + h <= H - 6;
    const top = below ? a.foot! + gap : Math.max(6, Math.min(H - h - 6, a.y - h - gap));
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    if (!tail) return;
    el.style.setProperty('--tail', `${Math.round(Math.max(14, Math.min(w - 14, a.x - left)))}px`);
    el.classList.toggle('below', below || top > a.y - h - gap + 1); // under them: tail on top
  }

  // The floor was redrawn: point everyone at their new figure (gone from the floor: dropped).
  rebind(speakerOf: (id: string) => Speaker | undefined): void {
    for (const [id, p] of this.people) {
      const s = speakerOf(id);
      if (s) p.speaker = s;
      else {
        if (this.panel?.id === id) this.close();
        this.forget(id);
      }
    }
    for (const [id, f] of this.flashes) {
      const s = speakerOf(id);
      if (s) f.speaker = s;
    }
  }

  clear(): void {
    this.close();
    for (const f of this.flashes.values()) f.el.remove();
    this.flashes.clear();
    for (const p of this.people.values()) p.mark.remove();
    this.people.clear();
  }
}

function nameTag(s: Speaker, title = s.name): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'tag';
  const tag = document.createElement('b');
  tag.className = 'who';
  tag.style.background = s.colour;
  tag.textContent = title;
  const role = document.createElement('small');
  role.textContent = s.role;
  wrap.append(tag, ' ', role);
  return wrap;
}

function load(key: string): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function save(key: string, d: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(d));
  } catch {
    // private window: remembered until the page reloads
  }
}

// A passing line: no markdown, one paragraph.
export function tidy(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`|^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\*(.+)\*$/s, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// A whole message to read: markdown marks gone, but paragraphs, lists and code kept.
export function readable(s: string): string {
  const t = s
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/gm, '$1$2') // *emphasis*
    .replace(/^#+\s*/gm, '')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > MAX_MESSAGE ? `${t.slice(0, MAX_MESSAGE - 1)}…` : t;
}
