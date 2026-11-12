// The manager's whiteboard: one short card per project. The office's own facts (who's
// in, last active) plus the manager's notebook section for that project, with their
// "Next:" suggestion first. Read from what the manager already wrote; no tokens.

import type { Floor } from '../../src/office/layout.ts';
import { dismissKey, parseNotebook, sectionFor, type Section } from './notebook.ts';
import type { BoardJob, DismissedItem } from './api.ts';

export class Board {
  private readonly el = document.getElementById('board')!;
  private readonly body = document.getElementById('board-body')!;
  private readonly meta = document.getElementById('board-meta')!;

  // The owner clicks Action on a suggested next step: the manager gets it as a job to hand out.
  onAction?: (room: string, next: string) => Promise<string | null>; // null: sent; string: what went wrong
  // The owner clicks × on a suggestion or job: they don't want it actioned, and the manager is told.
  onDismiss?: (room: string, text: string, job?: string) => Promise<string | null>;
  // The owner sets or clears a room's goal (folder: the room's project folder).
  onGoal?: (folder: string, goal: string) => Promise<string | null>;
  // The owner brings a dismissed item back from the Dismissed list at the bottom.
  onBringBack?: (room: string, text: string) => Promise<string | null>;

  constructor() {
    document.getElementById('board-close')!.onclick = () => this.hide();
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.hide(); // the dimmed backdrop
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.classList.contains('hidden')) this.hide();
    });
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  show(floor: Floor | undefined, sessions: Record<string, 'busy' | 'idle'>, notes: { notebook: string; updatedAt: number; jobs?: BoardJob[]; dismissed?: DismissedItem[]; goals?: Record<string, string>; office?: string[] } | { error: string }): void {
    this.el.classList.remove('hidden');
    if ('error' in notes) {
      this.meta.textContent = '';
      this.body.replaceChildren(p('muted', `Couldn't read the manager's notes: ${notes.error}`));
      return;
    }
    this.meta.textContent = notes.updatedAt ? `The manager's notes, updated ${ago(notes.updatedAt)}` : "The manager hasn't written any notes yet";
    const gone = new Set((notes.dismissed ?? []).map((d) => dismissKey(d.room, d.text)));
    const dismiss = this.onDismiss;
    const ui: CardUi = { onAction: this.onAction, onDismiss: dismiss, gone };
    const sections = parseNotebook(notes.notebook);
    const used = new Set<Section>();
    const cards: HTMLElement[] = [];
    // How the office is doing: how much it may do on its own now, and the last 24 hours in numbers.
    if (notes.office?.length) {
      const c = document.createElement('section');
      c.className = 'board-card board-office';
      const h = document.createElement('h3');
      h.textContent = 'The office, last 24 hours';
      c.append(h, ...notes.office.map((l) => p('board-facts', l)));
      cards.push(c);
    }
    // Open jobs first: what the owner asked for that isn't done, and what's waiting on them.
    if (notes.jobs?.length) {
      const c = document.createElement('section');
      c.className = 'board-card board-jobs';
      const h = document.createElement('h3');
      h.textContent = 'Open jobs';
      c.append(h);
      for (const j of notes.jobs) {
        const row = rich('board-next', `${j.room}: ${j.title}`);
        const status =
          j.status === 'waiting'
            ? rich('board-wait', `Waiting on you: ${j.waitingFor ?? 'not said'}`)
            : j.holdFor && j.holdUntil
              ? p('board-facts', `Waiting for ${j.holdFor} · back on it ${new Date(j.holdUntil).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`)
              : p('board-facts', `In progress · done when ${j.done}`);
        if (dismiss) row.append(' ', dismissButton('Drop this job: the manager tells the room to stop, and won\'t bring it back', () => dismiss(j.room, j.title, j.id), [row, status]));
        c.append(row, status);
      }
      cards.push(c);
    }
    for (const room of floor?.rooms ?? []) {
      if (room.kind !== 'project' || !room.project) continue;
      const s = sectionFor(room, sections);
      if (s) used.add(s);
      const st = sessions[`lead:${room.id}`];
      const status = st === 'busy' ? 'working' : st === 'idle' ? 'in' : 'out';
      const facts = [room.lead?.name.split(' ')[0], status === 'working' ? 'working now' : status === 'in' ? 'session open' : null, `active ${ago(room.project.lastActive)}`].filter(Boolean).join(' · ');
      const c = card(room.name, facts, status, s?.lines ?? [], ui);
      c.querySelector('.board-facts')!.after(goalRow(room.project.path, notes.goals?.[room.project.path] ?? '', this.onGoal));
      cards.push(c);
    }
    // Notes about projects without a room (archived, or no lead yet).
    for (const s of sections) if (!used.has(s) && s.lines.length) cards.push(card(s.title, 'not on the floor', 'out', s.lines, ui));
    if (notes.dismissed?.length) cards.push(dismissedCard(notes.dismissed, this.onBringBack));
    this.body.replaceChildren(...cards);
  }
}

interface CardUi {
  onAction?: (room: string, next: string) => Promise<string | null>;
  onDismiss?: (room: string, text: string, job?: string) => Promise<string | null>;
  gone: Set<string>; // dismissKey of everything the owner dismissed
}

function card(title: string, facts: string, status: string, lines: string[], ui: CardUi): HTMLElement {
  const { onAction, onDismiss } = ui;
  const c = document.createElement('section');
  c.className = 'board-card';
  const head = document.createElement('div');
  head.className = 'board-head';
  const dot = document.createElement('span');
  dot.className = `dot ${status}`;
  const h = document.createElement('h3');
  h.textContent = title;
  head.append(dot, h);
  c.append(head, p('board-facts', facts));
  // Up front: what to do next, and what's waiting on the owner. The rest folds away.
  const next = lines.filter((l) => /^next:/i.test(l));
  const wait = lines.filter((l) => /waiting on owner/i.test(l) && !/^next:/i.test(l));
  const rest = lines.filter((l) => !/^(next|updated):/i.test(l) && !wait.includes(l));
  for (const l of next) {
    const text = l.replace(/^next:\s*/i, '');
    if (ui.gone.has(dismissKey(title, text))) continue; // the owner said no to this one
    const row = rich('board-next', `→ ${text}`);
    // "Nothing pressing" isn't a step to action.
    if (onAction && !/^nothing\b/i.test(text)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'board-action';
      b.textContent = 'Action';
      b.title = 'The manager hands this to the room as a job, with a full brief';
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'Telling the manager…';
        const err = await onAction(title, text);
        b.textContent = err ? 'Try again' : 'The manager has it';
        if (err) {
          b.disabled = false;
          b.title = err;
        }
      };
      row.append(' ', b);
    }
    if (onDismiss && !/^nothing\b/i.test(text)) row.append(' ', dismissButton("Don't action this: the manager takes it off and won't suggest it again", () => onDismiss(title, text), [row]));
    c.append(row);
  }
  for (const l of wait) c.append(rich('board-wait', `Waiting on you: ${l.replace(/^.*?waiting on owner:?\s*/i, '')}`));
  if (rest.length) {
    const d = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = `The manager's notes (${rest.length})`;
    const ul = document.createElement('ul');
    for (const l of rest) ul.append(rich('', l, 'li'));
    d.append(sum, ul);
    c.append(d);
  }
  return c;
}

// The room's goal, which only the owner sets: shown under the facts, with Set / Edit to type a new one.
function goalRow(folder: string, goal: string, onGoal?: (folder: string, goal: string) => Promise<string | null>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'board-goal';
  const text = p(goal ? 'board-goal-text' : 'board-goal-text muted', goal ? `Goal: ${goal}` : 'No goal yet');
  row.append(text);
  if (!onGoal) return row;
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'board-action';
  edit.textContent = goal ? 'Edit' : 'Set goal';
  edit.title = 'Your goal for this room: the manager steers its next moves toward it';
  edit.onclick = () => {
    const form = document.createElement('form');
    form.className = 'board-goal-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.value = goal;
    input.placeholder = 'e.g. 1.5 in the App Store, 100 paying users';
    input.setAttribute('aria-label', 'Goal for this room');
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'board-action';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'board-action';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => form.replaceWith(row);
    form.append(input, save, cancel);
    form.onsubmit = async (e) => {
      e.preventDefault();
      save.disabled = true;
      save.textContent = 'Telling the manager…';
      const err = await onGoal(folder, input.value);
      if (err) {
        save.disabled = false;
        save.textContent = 'Try again';
        save.title = err;
        return;
      }
      form.replaceWith(goalRow(folder, input.value.replace(/\s+/g, ' ').trim().slice(0, 200), onGoal));
    };
    row.replaceWith(form);
    input.focus();
  };
  row.append(' ', edit);
  return row;
}

// Everything the owner dismissed, folded away, each with Bring back (The manager is told, a job reopens).
function dismissedCard(items: DismissedItem[], onBringBack?: (room: string, text: string) => Promise<string | null>): HTMLElement {
  const c = document.createElement('section');
  c.className = 'board-card board-dismissed';
  const d = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = `Dismissed (${items.length})`;
  const ul = document.createElement('ul');
  for (const it of items) {
    const li = rich('', `${it.room}: ${it.text}${it.job ? ' (job)' : ''}`, 'li');
    if (onBringBack) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'board-action';
      b.textContent = 'Bring back';
      b.title = it.job ? 'Reopen the job; the manager tells the room to carry on' : 'The manager may suggest or action it again';
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = 'Telling the manager…';
        const err = await onBringBack(it.room, it.text);
        if (!err) {
          li.remove();
          const left = ul.children.length;
          if (left) sum.textContent = `Dismissed (${left})`;
          else c.remove();
        } else {
          b.disabled = false;
          b.textContent = 'Try again';
          b.title = err;
        }
      };
      li.append(' ', b);
    }
    ul.append(li);
  }
  d.append(sum, ul);
  c.append(d);
  return c;
}

// The × on a suggestion or job. Gone from the board once the manager has it on file.
function dismissButton(tip: string, go: () => Promise<string | null>, rows: HTMLElement[]): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'board-dismiss';
  b.textContent = '×';
  b.title = tip;
  b.setAttribute('aria-label', tip);
  b.onclick = async () => {
    b.disabled = true;
    const err = await go();
    if (!err) for (const r of rows) r.remove();
    else {
      b.disabled = false;
      b.title = `Didn't go through: ${err}`;
    }
  };
  return b;
}

function p(cls: string, text: string): HTMLElement {
  const e = document.createElement('p');
  e.className = cls;
  e.textContent = text;
  return e;
}

// **bold** and `code`, built as elements (never innerHTML).
function rich(cls: string, text: string, tag = 'p'): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = part.slice(2, -2);
      e.append(b);
    } else if (part.startsWith('`') && part.endsWith('`')) {
      const k = document.createElement('code');
      k.textContent = part.slice(1, -1);
      e.append(k);
    } else e.append(part);
  }
  return e;
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
