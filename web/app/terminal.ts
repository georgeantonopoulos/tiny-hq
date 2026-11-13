// The project terminal: a real Claude Code session in a project's folder, shown
// with xterm.js. Joining attaches to the live session (the one manager may
// be using); "New conversation" starts a fresh one. Leaving only detaches.
// Every worker the owner opened gets a tab; the tabs and the active one are
// remembered, so the page comes back on the session they were last in.

import { isRemote, type Api } from './api.ts';
import { phoneTyping } from './phone-typing.ts';
import { tabColours } from './tab-colours.ts';
import { linksOnRow } from './term-links.ts';

interface XTerm {
  cols: number;
  rows: number;
  open(el: HTMLElement): void;
  write(data: string): void;
  onData(cb: (d: string) => void): { dispose(): void };
  onResize(cb: (s: { cols: number; rows: number }) => void): { dispose(): void };
  loadAddon(a: unknown): void;
  registerLinkProvider(p: { provideLinks(y: number, cb: (links: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate(e: MouseEvent, text: string): void }[] | undefined) => void): void }): { dispose(): void };
  buffer: { active: { length: number; getLine(y: number): { isWrapped: boolean; length: number; translateToString(trim?: boolean): string; getCell(x: number): { getChars(): string; getWidth(): number } | undefined } | undefined } };
  focus(): void;
  scrollToBottom(): void;
  dispose(): void;
}
declare const Terminal: new (opts: Record<string, unknown>) => XTerm;
declare const FitAddon: { FitAddon: new () => { fit(): void } };

interface Tab {
  projectPath: string;
  name: string;
}
const TABS_KEY = 'cm-term-tabs';


export class TerminalPanel {
  private readonly panel = document.getElementById('term-panel')!;
  private readonly body = document.getElementById('term-body')!;
  private readonly title = document.getElementById('term-title')!;
  private readonly meta = document.getElementById('term-meta')!;
  private current?: { termId: string; xterm: XTerm; abort: AbortController; onWinResize: () => void; offSwipe?: () => void; offSizer?: () => void; projectPath: string; name: string };

  private readonly api: Api;
  private readonly strip = document.getElementById('term-activity')!;
  private stripUntil = 0;
  private busyNames: string[] = [];
  private opening = 0; // bumps on every open/leave; a reply for an older one is thrown away

  private readonly onLayout: () => void;
  private readonly tabsEl = document.getElementById('term-tabs')!;
  colourFor: (projectPath: string) => string | undefined = () => undefined; // the person's shirt on the floor
  private tabs: Tab[] = [];
  private active?: string; // projectPath of the selected tab
  private openingPath?: string; // the tab whose open is in flight
  private unsent = ''; // keys that didn't reach the Mac (say the office restarted): sent again after rejoining
  private rejoining?: string; // termId we're rejoining from

  constructor(api: Api, onLayout: () => void = () => undefined) {
    this.api = api;
    this.onLayout = onLayout;
    this.wireGrip();
    this.loadTabs();
    document.getElementById('term-close')!.onclick = () => {
      // Closed on purpose: don't pop back open on the next reload.
      this.active = undefined;
      this.saveTabs();
      this.renderTabs();
      this.leave();
    };
    document.getElementById('term-new')!.onclick = () => {
      const c = this.current;
      // Already confirmed on this phone for this panel; New conversation asks again only if it was never open.
      if (c) void this.open(c.projectPath, c.name, 'new', c.termId !== '');
    };
  }

  async open(projectPath: string, name: string, mode: 'join' | 'new' | 'resume' = 'join', confirmed = false, trusted = false): Promise<void> {
    this.leave(false);
    this.addTab(projectPath, name);
    const mine = ++this.opening;
    this.openingPath = projectPath;
    this.panel.classList.remove('hidden');
    document.body.classList.add('term-open');
    this.onLayout();
    this.title.textContent = name;
    // From the phone, a terminal is a full shell as the owner: ask every time.
    if (isRemote() && !confirmed) {
      this.meta.textContent = '';
      this.confirmBox(projectPath, name, mode);
      return;
    }
    this.meta.textContent = mode === 'new' ? 'Starting a new conversation…' : 'Joining…';
    const xterm = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      allowProposedApi: false,
      theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
    });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open(this.body);
    fit.fit();
    // Web addresses in the chat open in a new tab when tapped or clicked (copying one out of the chat
    // is hard on a phone), including ones that wrap onto the next line.
    xterm.registerLinkProvider({
      provideLinks(y, cb) {
        const links = linksOnRow(xterm.buffer.active, y).map((l) => ({ ...l, activate: () => window.open(l.text, '_blank', 'noopener,noreferrer') }));
        cb(links.length ? links : undefined);
      },
    });
    // Something on screen straight away while Claude gets ready.
    xterm.write(`\x1b[2m  ${mode === 'new' ? `Pulling up a chair at ${name}…` : `Walking over to ${name}…`}\x1b[0m\r\n`);
    this.busy(true);
    const r = await this.api.openTerminal(projectPath, mode, xterm.cols, xterm.rows, confirmed, trusted);
    if (mine !== this.opening) {
      // The owner left or opened something else meanwhile: let this one go.
      xterm.dispose(); // the session's viewer stays on the Mac for next time
      return;
    }
    this.busy(false);
    this.openingPath = undefined;
    // Reopening the last tab on load never starts a session: if nobody's in, just close.
    if ('error' in r && mode === 'resume') {
      xterm.dispose();
      this.leave();
      return;
    }
    // Claude Code hasn't been told to trust this folder: ask here instead of sending the owner to a terminal.
    if ('error' in r && r.trust) {
      xterm.dispose();
      this.meta.textContent = '';
      this.trustBox(projectPath, name, mode, confirmed);
      return;
    }
    if ('error' in r) {
      xterm.write(`\r\nCouldn't open the session: ${r.error}\r\n`);
      this.meta.textContent = '';
      this.current = { termId: '', xterm, abort: new AbortController(), onWinResize: () => undefined, projectPath, name };
      return;
    }
    this.meta.textContent = r.fresh ? 'New conversation' : 'Joined';
    this.meta.title = `${r.session} · ${projectPath}`;
    const abort = new AbortController();
    // Keystrokes are sent in small batches, one request at a time, so they always
    // arrive in the order they were typed (over the phone link too).
    let pending = '';
    let sending = false;
    const flush = async () => {
      if (sending) return;
      sending = true;
      try {
        while (pending && this.current?.termId === r.termId) {
          const data = pending;
          pending = '';
          const res = await this.api.termSend(r.termId, 'input', { data }).catch(() => null);
          if (!res?.ok) {
            // Didn't arrive (the office restarted, or the link dropped): keep it, rejoin, send it then.
            this.unsent += data + pending;
            pending = '';
            void this.rejoin(r.termId);
            return;
          }
        }
      } finally {
        sending = false;
      }
    };
    let timer: number | undefined;
    const type = (d: string) => {
      pending += d;
      timer ??= window.setTimeout(() => {
        timer = undefined;
        void flush();
      }, 12);
    };
    xterm.onData(type);
    // Phone keyboards (swipe typing, autocorrect) type through one path of our own.
    const offPhone = phoneTyping(this.body, (d) => {
      xterm.scrollToBottom(); // as xterm does for keys it sends itself
      type(d);
    });
    xterm.onResize(({ cols, rows }) => {
      if (this.current?.termId === r.termId) void this.api.termSend(r.termId, 'resize', { cols, rows });
    });
    // Claude Code takes over the whole screen and scrolls itself on mouse-wheel
    // signals. A finger swipe sends none, so vertical swipes become wheel turns.
    const offSwipe = swipeToScroll(this.body);

    // The terminal fits whatever space the layout gives it (dock, drag, keyboard).
    const sizer = new ResizeObserver(() => fit.fit());
    sizer.observe(this.body);
    // Phones shrink only the visible area for the on-screen keyboard: while it's
    // up, the terminal takes the whole visible screen so the input line shows.
    const onWinResize = () => {
      const vv = window.visualViewport;
      const kb = !!vv && matchMedia('(max-width: 899px)').matches && vv.height < window.innerHeight * 0.8;
      document.body.classList.toggle('kb-open', kb);
      document.body.style.height = kb && vv ? `${vv.height}px` : '';
      if (kb) window.scrollTo(0, 0);
      fit.fit();
      this.onLayout();
    };
    window.addEventListener('resize', onWinResize);
    window.visualViewport?.addEventListener('resize', onWinResize);
    onWinResize();
    // Images: the browser only hands text to the terminal, so a pasted or dropped
    // image goes to the Mac, which saves it and pastes its path into Claude.
    // Pictures and documents (from a phone too): the paperclip in the header picks them;
    // pasting or dropping works too. A clipboard picture has no name, so it goes as an image.
    const sendImages = (files: File[]) => {
      for (const f of files) {
        const what = f.type.startsWith('image/') ? 'Picture' : 'File';
        this.meta.textContent = `Sending ${f.name || what.toLowerCase()}…`;
        void (f.name && /\.[A-Za-z0-9]{1,5}$/.test(f.name) ? this.api.termFile(r.termId, f) : this.api.termImage(r.termId, f))
          .then(async (res) => {
            this.meta.textContent = res.ok ? `${what} attached: add what to do with it, then Enter` : `${what} not sent: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`;
          })
          .catch(() => (this.meta.textContent = `${what} not sent: no link to the Mac`));
      }
    };
    const images = (list: DataTransferItemList | undefined | null) => [...(list ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    const picker = document.getElementById('term-file') as HTMLInputElement | null;
    const onPick = () => {
      const files = [...(picker?.files ?? [])];
      if (picker) picker.value = '';
      if (files.length) sendImages(files);
    };
    picker?.addEventListener('change', onPick);
    const onPaste = (e: ClipboardEvent) => {
      const files = images(e.clipboardData?.items);
      if (!files.length) return; // plain text: xterm pastes it as usual
      e.preventDefault();
      e.stopImmediatePropagation();
      sendImages(files);
    };
    const onDragOver = (e: DragEvent) => {
      if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = images(e.dataTransfer?.items);
      if (!files.length) return;
      e.preventDefault();
      sendImages(files);
    };
    this.body.addEventListener('paste', onPaste, true);
    this.body.addEventListener('dragover', onDragOver);
    this.body.addEventListener('drop', onDrop);
    const offSizer = () => {
      offPhone();
      sizer.disconnect();
      this.body.removeEventListener('paste', onPaste, true);
      picker?.removeEventListener('change', onPick);
      this.body.removeEventListener('dragover', onDragOver);
      this.body.removeEventListener('drop', onDrop);
    };
    this.current = { termId: r.termId, xterm, abort, onWinResize, offSwipe, offSizer, projectPath, name };
    xterm.focus();
    // Keys typed while the link was down: they go now, in order.
    if (this.unsent) {
      const data = this.unsent;
      this.unsent = '';
      setTimeout(() => {
        if (this.current?.termId === r.termId) void this.api.termSend(r.termId, 'input', { data });
      }, 1500); // once Claude's screen is back up
    }
    // A viewer that was already attached replays its screen; a size nudge makes Claude redraw it cleanly.
    setTimeout(() => {
      if (this.current?.termId === r.termId) void this.api.termSend(r.termId, 'resize', { cols: xterm.cols, rows: xterm.rows, repaint: true });
    }, 150);
    this.api
      .termStream(r.termId, (chunk) => xterm.write(chunk), abort.signal)
      .then(() => {
        if (this.current?.termId === r.termId && !abort.signal.aborted) void this.rejoin(r.termId);
      })
      .catch(() => undefined);
  }

  // The link to the Mac dropped (usually the office restarting after an update):
  // wait until it answers again, then rejoin the same session. Nothing typed is lost.
  private async rejoin(termId: string): Promise<void> {
    const c = this.current;
    if (!c || c.termId !== termId || this.rejoining === termId) return;
    this.rejoining = termId;
    try {
      this.meta.textContent = 'Reconnecting (the office restarted)…';
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        if (this.current?.termId !== termId) return; // the owner moved on
        const up = await this.api.sessions().then(() => true, () => false);
        if (up) {
          await this.open(c.projectPath, c.name, 'resume', true);
          return;
        }
      }
      this.meta.textContent = "Can't reach the Mac. Close it and open the room again.";
    } finally {
      if (this.rejoining === termId) this.rejoining = undefined;
    }
  }

  // Reopen the tab the owner was last in (on the Mac; a phone asks before every open).
  restore(): void {
    const t = this.tabs.find((x) => x.projectPath === this.active);
    if (t && !isRemote()) void this.open(t.projectPath, t.name, 'resume');
  }

  private addTab(projectPath: string, name: string): void {
    const t = this.tabs.find((x) => x.projectPath === projectPath);
    if (t) t.name = name;
    else this.tabs.push({ projectPath, name });
    this.active = projectPath;
    this.saveTabs();
    this.renderTabs();
  }

  private closeTab(projectPath: string): void {
    const i = this.tabs.findIndex((x) => x.projectPath === projectPath);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.active === projectPath) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.active = next?.projectPath;
      if (next) void this.open(next.projectPath, next.name);
      else this.leave();
    }
    this.saveTabs();
    this.renderTabs();
  }

  renderTabs(): void {
    const colours = tabColours(this.tabs.map((t) => this.colourFor(t.projectPath)));
    this.tabsEl.replaceChildren(
      ...this.tabs.map((t, i) => {
        const tab = document.createElement('div');
        tab.className = 'term-tab';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(t.projectPath === this.active));
        tab.title = `${t.name} · ${t.projectPath}`;
        const colour = colours[i];
        if (colour) tab.style.setProperty('--who', colour);
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = t.name.split(' · ')[0] ?? t.name;
        const x = document.createElement('button');
        x.className = 'x';
        x.type = 'button';
        x.textContent = '×';
        x.title = 'Close this tab; the session keeps running';
        x.onclick = (e) => {
          e.stopPropagation();
          this.closeTab(t.projectPath);
        };
        tab.onclick = () => {
          if (t.projectPath === this.openingPath) return; // already on its way
          // Another tab, nothing open, or the last try failed: (re)open it.
          if (t.projectPath !== this.active || !this.current || this.current.termId === '') void this.open(t.projectPath, t.name);
        };
        tab.append(label, x);
        return tab;
      }),
    );
    this.tabsEl.classList.toggle('hidden', !this.tabs.length);
  }

  private loadTabs(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}') as { tabs?: unknown; active?: unknown };
      if (Array.isArray(saved.tabs)) this.tabs = saved.tabs.filter((t): t is Tab => typeof t?.projectPath === 'string' && typeof t?.name === 'string').slice(0, 12);
      if (typeof saved.active === 'string') this.active = saved.active;
    } catch {
      // nothing remembered
    }
    this.renderTabs();
  }

  private saveTabs(): void {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: this.tabs, active: this.active }));
    } catch {
      // fine: tabs just won't be remembered
    }
  }

  // Detach: the session keeps running in the background.
  // The office, seen from inside a terminal: who's working, and the latest reply.
  working(names: string[]): void {
    this.busyNames = names;
    if (Date.now() < this.stripUntil) return;
    this.strip.textContent = names.length ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} working…` : '';
    this.strip.classList.toggle('hidden', !names.length);
  }

  activity(text: string): void {
    const plain = text.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
    this.strip.textContent = plain.length > 160 ? `${plain.slice(0, 157)}…` : plain;
    this.strip.classList.remove('hidden');
    this.stripUntil = Date.now() + 12_000;
    setTimeout(() => {
      if (Date.now() >= this.stripUntil) this.working(this.busyNames);
    }, 12_100);
  }

  private confirmBox(projectPath: string, name: string, mode: 'join' | 'new' | 'resume'): void {
    const box = document.createElement('div');
    box.className = 'term-confirm';
    const p = document.createElement('p');
    p.textContent = `Open Claude in ${projectPath} from this phone? It runs as you on the Mac, in auto mode, and can run any command there.`;
    const yes = document.createElement('button');
    yes.textContent = 'Yes, open it';
    yes.onclick = () => void this.open(projectPath, name, mode, true);
    const no = document.createElement('button');
    no.className = 'ghost';
    no.textContent = 'Cancel';
    no.onclick = () => this.leave();
    const row = document.createElement('div');
    row.className = 'row';
    row.append(yes, no);
    box.append(p, row);
    this.body.replaceChildren(box);
  }

  // Claude Code asks once per folder whether to trust it, and a session the office starts can't show
  // that question, so the page asks it. Only this click marks the folder trusted.
  private trustBox(projectPath: string, name: string, mode: 'join' | 'new' | 'resume', confirmed: boolean): void {
    const box = document.createElement('div');
    box.className = 'term-confirm';
    const p = document.createElement('p');
    p.textContent = `Claude Code hasn't been told to trust ${projectPath} yet. It asks this once for each folder: trusting it lets Claude read the files there and run commands in it.`;
    const yes = document.createElement('button');
    yes.textContent = 'Trust and open';
    yes.onclick = () => void this.open(projectPath, name, mode, confirmed, true);
    const no = document.createElement('button');
    no.className = 'ghost';
    no.textContent = 'Cancel';
    no.onclick = () => this.leave();
    const row = document.createElement('div');
    row.className = 'row';
    row.append(yes, no);
    box.append(p, row);
    this.body.replaceChildren(box);
  }

  private busy(on: boolean): void {
    for (const id of ['term-new', 'term-close']) (document.getElementById(id) as HTMLButtonElement).disabled = on && id === 'term-new';
  }

  // Close the panel. The session and its viewer stay on the Mac, so opening the
  // room again is instant; `hide: false` keeps the dock open for the next one.
  leave(hide = true): void {
    this.opening++;
    this.openingPath = undefined;
    this.busy(false);
    const c = this.current;
    this.current = undefined;
    if (c) {
      c.abort.abort();
      window.removeEventListener('resize', c.onWinResize);
      window.visualViewport?.removeEventListener('resize', c.onWinResize);
      c.offSwipe?.();
      c.offSizer?.();
      c.xterm.dispose();
    }
    this.body.replaceChildren();
    if (!hide) return;
    this.panel.classList.add('hidden');
    document.body.classList.remove('term-open', 'kb-open');
    document.body.style.height = '';
    this.onLayout();
  }

  // Drag the edge (Mac: left edge; phone: top bar) to give the office or Claude more room.
  private wireGrip(): void {
    const grip = document.getElementById('term-grip');
    if (!grip) return;
    const narrow = () => matchMedia('(max-width: 899px)').matches;
    const KEY = 'cm-term-size';
    const apply = (frac: number) => {
      const f = Math.min(0.85, Math.max(0.25, frac));
      document.documentElement.style.setProperty(narrow() ? '--term-h' : '--term-w', `${Math.round(f * 100)}%`);
      return f;
    };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { w?: number; h?: number };
      if (saved.w) document.documentElement.style.setProperty('--term-w', `${Math.round(saved.w * 100)}%`);
      if (saved.h) document.documentElement.style.setProperty('--term-h', `${Math.round(saved.h * 100)}%`);
    } catch {
      // no saved size
    }
    // On a phone the whole header bar is the handle: the thin grip is too small to
    // hit, and with the keyboard up it sits off the top of the screen.
    const head = grip.parentElement!.querySelector<HTMLElement>('.term-head');
    const start = (e: PointerEvent, el: HTMLElement) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      // Keyboard up means the terminal fills the screen: dragging puts it away first.
      if (document.body.classList.contains('kb-open')) (document.activeElement as HTMLElement | null)?.blur();
      document.body.classList.add('resizing');
      let frac = 0;
      const move = (ev: PointerEvent) => {
        const area = document.querySelector('.layout')!.getBoundingClientRect(); // fresh: the layout changes once the keyboard goes
        frac = apply(narrow() ? (area.bottom - ev.clientY) / area.height : (area.right - ev.clientX) / area.width);
        this.onLayout();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing');
        try {
          const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
          if (frac) saved[narrow() ? 'h' : 'w'] = frac;
          localStorage.setItem(KEY, JSON.stringify(saved));
        } catch {
          // fine: it just won't be remembered
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up, { once: true });
      el.addEventListener('pointercancel', up, { once: true });
    };
    grip.addEventListener('pointerdown', (e) => start(e, grip));
    head?.addEventListener('pointerdown', (e) => {
      if (!narrow() || (e.target as HTMLElement).closest('button, label, input')) return; // buttons stay buttons
      start(e, head);
    });
  }
}

// Vertical swipes on the terminal become wheel turns over the same spot, which
// xterm.js passes to Claude in whatever form Claude asked for. A tap (no real
// movement) still focuses the terminal so the keyboard comes up.
function swipeToScroll(host: HTMLElement): () => void {
  const STEP = 18; // px of finger travel per wheel notch
  let last: { x: number; y: number } | null = null;
  let travelled = 0;
  const target = () => host.querySelector('.xterm-screen') ?? host;
  const start = (e: TouchEvent) => {
    if (e.touches.length !== 1) return (last = null);
    last = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    travelled = 0;
  };
  const move = (e: TouchEvent) => {
    if (!last || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    travelled += last.y - t.clientY;
    last = { x: t.clientX, y: t.clientY };
    // Once it's clearly a scroll, the page and xterm's own touch handling stay out of it.
    if (Math.abs(travelled) > 4) {
      e.preventDefault();
      e.stopPropagation();
    }
    while (Math.abs(travelled) >= STEP) {
      const down = travelled > 0;
      travelled += down ? -STEP : STEP;
      target().dispatchEvent(new WheelEvent('wheel', { deltaY: down ? 40 : -40, deltaMode: 0, clientX: t.clientX, clientY: t.clientY, bubbles: true, cancelable: true }));
    }
  };
  const end = () => (last = null);
  host.addEventListener('touchstart', start, { passive: true, capture: true });
  host.addEventListener('touchmove', move, { passive: false, capture: true });
  host.addEventListener('touchend', end, { capture: true });
  host.addEventListener('touchcancel', end, { capture: true });
  return () => {
    host.removeEventListener('touchstart', start, { capture: true });
    host.removeEventListener('touchmove', move, { capture: true });
    host.removeEventListener('touchend', end, { capture: true });
    host.removeEventListener('touchcancel', end, { capture: true });
  };
}
