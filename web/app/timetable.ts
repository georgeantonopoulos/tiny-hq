// The timetable on the manager's wall: every scheduled task the office runs for them,
// when it runs next, when it last ran, and a switch to turn each one on or off.

import type { Api } from './api.ts';

export interface TimetableTask {
  id: string;
  title: string;
  when: string;
  enabled: boolean;
  until?: string;
  next: number | null;
  lastRun: number | null;
  createdBy: string | null;
  prompt: string;
}

export class Timetable {
  private readonly el = document.getElementById('timetable')!;
  private readonly body = document.getElementById('timetable-body')!;
  private readonly api: Api;

  constructor(api: Api) {
    this.api = api;
    document.getElementById('timetable-close')!.onclick = () => this.hide();
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
    const r = await this.api.schedule();
    if ('error' in r) {
      this.body.replaceChildren(line('muted', `Couldn't read the timetable: ${r.error}`));
      return;
    }
    if (!r.tasks.length) {
      this.body.replaceChildren(line('muted', 'Nothing scheduled.'));
      return;
    }
    this.body.replaceChildren(...r.tasks.map((t) => this.row(t)));
  }

  private row(t: TimetableTask): HTMLElement {
    const row = document.createElement('section');
    row.className = `tt-row${t.enabled ? '' : ' off'}`;
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'tt-switch';
    sw.checked = t.enabled;
    sw.setAttribute('aria-label', `${t.title}: ${t.enabled ? 'on' : 'off'}`);
    sw.onchange = async () => {
      sw.disabled = true;
      const r = await this.api.setScheduleEnabled(t.id, sw.checked);
      sw.disabled = false;
      if ('error' in r) {
        sw.checked = !sw.checked;
        note.textContent = r.error;
        return;
      }
      void this.show();
    };
    const main = document.createElement('div');
    main.className = 'tt-main';
    const h = document.createElement('h3');
    h.textContent = t.title;
    const when = line('tt-when', `${t.when}${t.until ? `, until ${t.until}` : ''}`);
    const times = [t.enabled && t.next ? `next ${when_(t.next)}` : t.enabled ? 'finished' : 'off', t.lastRun ? `last ran ${when_(t.lastRun)}` : 'not run yet', t.createdBy ? `added by ${t.createdBy}` : ''].filter(Boolean).join(' · ');
    const meta = line('tt-meta', times);
    const what = line('tt-what', t.prompt);
    const note = line('tt-note', '');
    main.append(h, when, meta, what, note);
    row.append(sw, main);
    return row;
  }
}

function line(cls: string, text: string): HTMLElement {
  const e = document.createElement('p');
  e.className = cls;
  e.textContent = text;
  return e;
}

// "today 14:17", "tomorrow 08:30", "Mon 10:17".
function when_(ms: number): string {
  const d = new Date(ms);
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - day.getTime()) / 86_400_000);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `today ${hm}`;
  if (diff === 1) return `tomorrow ${hm}`;
  if (diff === -1) return `yesterday ${hm}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}
