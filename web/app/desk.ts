// The owner's desk: the reports they asked for as a folder tree, like Finder: one folder for each
// kind of report, the same folders as on disk (src/team/desk.ts). Newest first in each, unread
// ones marked; one tap opens a report as a readable page. The office turns each report's Markdown into safe HTML
// (src/team/desk.ts escapes everything first), so it's shown as given.

import type { Api } from './api.ts';

export interface DeskReport {
  id: string;
  title: string;
  from: string;
  at: number;
  read?: number;
  folder: string; // '' for the top of the desk folder, else 'Security' or 'Security/Atlas'
  link?: string; // the report as its own page, signed by the office (good for 12 hours)
}

export interface DeskTree {
  root: string; // where the folders are, e.g. "iCloud Drive/Office Desk"
  folders: string[];
  reports: DeskReport[];
}

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  reports: DeskReport[];
}

// The flat list from the office as nested folders, alphabetical, reports newest first.
export function deskTree(t: DeskTree): Folder {
  const top: Folder = { name: '', path: '', folders: [], reports: [] };
  const find = (path: string): Folder => {
    if (!path) return top;
    let f = top;
    let at = '';
    for (const part of path.split('/')) {
      at = at ? `${at}/${part}` : part;
      let next = f.folders.find((x) => x.name === part);
      if (!next) {
        next = { name: part, path: at, folders: [], reports: [] };
        f.folders.push(next);
      }
      f = next;
    }
    return f;
  };
  for (const p of t.folders) find(p);
  for (const r of t.reports) find(r.folder).reports.push(r);
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.reports.sort((a, b) => b.at - a.at);
    f.folders.forEach(sort);
  };
  sort(top);
  return top;
}

const count = (f: Folder): { all: number; unread: number } =>
  f.folders.map(count).reduce((a, b) => ({ all: a.all + b.all, unread: a.unread + b.unread }), { all: f.reports.length, unread: f.reports.filter((r) => !r.read).length });

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
    this.meta.textContent = r.root;
    this.meta.title = 'These are real folders on your disk';
    if (!r.reports.length && !r.folders.length) {
      this.body.replaceChildren(line('Nothing on your desk yet. Reports you ask the manager or a room for land here.'));
      return;
    }
    const top = deskTree(r);
    const tree = document.createElement('div');
    tree.className = 'desk-tree';
    tree.append(...top.folders.map((f) => this.folder(f)), ...top.reports.map((rep) => this.row(rep)));
    this.body.replaceChildren(tree);
  }

  // One folder: a row you open and close like Finder's, its subfolders and reports inside.
  private folder(f: Folder): HTMLElement {
    const d = document.createElement('details');
    d.className = 'desk-folder';
    const { all, unread } = count(f);
    d.open = unread > 0 || this.opened.has(f.path);
    d.ontoggle = () => (d.open ? this.opened.add(f.path) : this.opened.delete(f.path));
    const s = document.createElement('summary');
    const name = document.createElement('span');
    name.className = 'desk-folder-name';
    name.textContent = f.name;
    const n = document.createElement('span');
    n.className = 'desk-folder-count';
    n.textContent = unread ? `${unread} new · ${all}` : String(all);
    s.append(name, n);
    const inside = document.createElement('div');
    inside.className = 'desk-folder-body';
    inside.append(...f.folders.map((x) => this.folder(x)), ...f.reports.map((rep) => this.row(rep)));
    if (!all) inside.append(line('Empty'));
    d.append(s, inside);
    return d;
  }
  private readonly opened = new Set<string>(); // folders the owner opened, kept open when they come back

  // A report opens as its own designed page in a new tab, through the signed link
  // the office put on it. Opening it marks it read on the office's side.
  private row(rep: DeskReport): HTMLElement {
    const b = document.createElement('a');
    if (rep.link) b.href = rep.link;
    b.target = '_blank';
    b.rel = 'noopener noreferrer';
    b.className = `desk-row${rep.read ? '' : ' unread'}`;
    const h = document.createElement('h3');
    h.textContent = rep.title;
    const m = document.createElement('p');
    m.textContent = `${rep.read ? '' : 'New · '}${rep.from ? `from ${rep.from} · ` : ''}${when(rep.at)}`;
    b.append(h, m);
    b.onclick = () => {
      b.classList.remove('unread');
      m.textContent = m.textContent!.replace(/^New · /, '');
      setTimeout(() => this.onRead?.(), 1500); // the tab has asked for it by then: the count drops
    };
    return b;
  }

  // The coffee room's board: each tip with an × for the owner (it goes, and never comes back).
  showBoard(meta: string, tips: { id: string; kind: string; text: string; from: string; seen: number }[], remove: (id: string) => Promise<string | null>, empty = 'Nothing yet: no room has posted a tip.'): void {
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
      p.textContent = empty;
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

  // A link straight to one report (…/#desk=<id>): this tab goes to the report's own page.
  async open(id: string): Promise<void> {
    const r = await this.api.desk();
    const link = 'error' in r ? undefined : r.reports.find((x) => x.id === id)?.link;
    if (link) return location.assign(link);
    await this.show();
    this.body.prepend(line("Couldn't find that report: here's the desk."));
  }
}

function line(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}
