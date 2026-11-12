// The owner's desk: the reports they asked for, newest first, unread ones marked; one tap opens a
// report as a readable page. The office turns each report's Markdown into safe HTML
// (src/team/desk.ts escapes everything first), so it's shown as given.

import type { Api } from './api.ts';

export interface DeskReport {
  id: string;
  title: string;
  from: string;
  at: number;
  read?: number;
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export class Desk {
  private readonly el = document.getElementById('desk')!;
  private readonly body = document.getElementById('desk-body')!;
  private readonly title = document.getElementById('desk-title')!;
  private readonly meta = document.getElementById('desk-meta')!;
  private readonly back = document.getElementById('desk-back') as HTMLButtonElement;
  private readonly api: Api;
  onRead?: () => void; // a report was opened: the desk's unread count changes

  constructor(api: Api) {
    this.api = api;
    document.getElementById('desk-close')!.onclick = () => this.hide();
    this.back.onclick = () => void this.show();
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.hide();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.classList.contains('hidden')) this.hide();
    });
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  async show(): Promise<void> {
    this.el.classList.remove('hidden');
    this.back.hidden = true;
    this.title.textContent = 'Your desk';
    this.meta.textContent = 'Reports you asked for';
    const r = await this.api.desk();
    if ('error' in r) {
      this.body.replaceChildren(line(`Couldn't read the desk: ${r.error}`));
      return;
    }
    if (!r.reports.length) {
      this.body.replaceChildren(line('Nothing on your desk yet. Reports you ask the manager or a room for land here.'));
      return;
    }
    this.body.replaceChildren(...r.reports.map((rep) => this.row(rep)));
  }

  private row(rep: DeskReport): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `desk-row${rep.read ? '' : ' unread'}`;
    const h = document.createElement('h3');
    h.textContent = rep.title;
    const m = document.createElement('p');
    m.textContent = `${rep.read ? '' : 'New · '}from ${rep.from} · ${when(rep.at)}`;
    b.append(h, m);
    b.onclick = () => void this.open(rep.id);
    return b;
  }

  // The coffee room's board: each tip with an × for the owner (it goes, and never comes back).
  showBoard(meta: string, tips: { id: string; kind: string; text: string; from: string; seen: number }[], remove: (id: string) => Promise<string | null>): void {
    this.el.classList.remove('hidden');
    this.back.hidden = true;
    this.title.textContent = 'Coffee room board';
    this.meta.textContent = meta;
    const sections: [string, string][] = [['owner', 'How you like to work'], ['tip', 'Useful tips'], ['bug', 'Bugs and traps'], ['mac', 'The Mac and its tools']];
    const page = document.createElement('article');
    page.className = 'report coffee-board';
    for (const [kind, heading] of sections) {
      const mine = tips.filter((t) => t.kind === kind).sort((a, b) => b.seen - a.seen);
      if (!mine.length) continue;
      const h = document.createElement('h3');
      h.textContent = heading;
      const ul = document.createElement('ul');
      for (const t of mine) {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.textContent = t.text;
        const who = document.createElement('small');
        who.textContent = ` ${t.from}${t.seen > 1 ? ` · confirmed ${t.seen}×` : ''}`;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ghost tip-x';
        x.textContent = '×';
        x.title = 'Remove this tip; it won\'t come back';
        x.onclick = async () => {
          x.disabled = true;
          const err = await remove(t.id);
          if (err) {
            x.disabled = false;
            who.textContent = ` ${err}`;
          } else li.remove();
        };
        li.append(text, who, x);
        ul.append(li);
      }
      page.append(h, ul);
    }
    if (!page.children.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Nothing yet: the first coffee break is still to come.';
      page.append(p);
    }
    this.body.replaceChildren(page);
    this.el.scrollTop = 0;
  }

  // Any page in the same reader.
  showPage(title: string, meta: string, html: string): void {
    this.el.classList.remove('hidden');
    this.back.hidden = true;
    this.title.textContent = title;
    this.meta.textContent = meta;
    const page = document.createElement('article');
    page.className = 'report';
    page.innerHTML = html; // made by the office from Markdown, everything escaped (src/team/desk.ts)
    this.body.replaceChildren(page);
    this.el.scrollTop = 0;
  }

  async open(id: string): Promise<void> {
    this.el.classList.remove('hidden');
    const r = await this.api.deskReport(id);
    if ('error' in r) {
      this.body.replaceChildren(line(`Couldn't open it: ${r.error}`));
      return;
    }
    this.back.hidden = false;
    this.title.textContent = r.title;
    this.meta.textContent = `from ${r.from} · ${when(r.at)}`;
    const page = document.createElement('article');
    page.className = 'report';
    page.innerHTML = r.html; // made by the office from Markdown, everything escaped (src/team/desk.ts)
    this.body.replaceChildren(page);
    this.el.scrollTop = 0;
    this.onRead?.();
  }
}

function line(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}
