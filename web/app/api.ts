// Talks to the daemon. The token arrives in the URL #fragment (never sent to a
// server), is kept for this tab (or, on a paired phone, on that device), and goes in a header.

import type { Floor } from '../../src/office/layout.ts';
import { validGag, type Gag } from './whimsy.ts';

const KEY = 'cm-token';
// Over Tailscale the key belongs to this paired device, so it's kept
// across visits; on the Mac it lives only as long as the tab.
export const isRemote = (): boolean => !['127.0.0.1', 'localhost'].includes(location.hostname);
const store = (): Storage => (isRemote() ? localStorage : sessionStorage);

// Signs in with the one-time #code from `tiny-hq open`, or reuses this tab's token.
export async function takeToken(): Promise<string | null> {
  const m = /code=([a-f0-9]{48})/.exec(location.hash);
  if (m?.[1]) {
    history.replaceState(null, '', location.pathname + location.search);
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: m[1] }) });
    if (r.ok) store().setItem(KEY, ((await r.json()) as { token: string }).token);
  }
  return store().getItem(KEY);
}

export function forgetToken(): void {
  store().removeItem(KEY);
}

export class AuthError extends Error {}

export class Api {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async floor(refresh = false): Promise<Floor> {
    const r = await fetch(`/api/floor${refresh ? '?refresh=1' : ''}`, { headers: this.headers() });
    if (r.status === 401 || r.status === 403) throw new AuthError(`floor: ${r.status}`);
    if (!r.ok) throw new Error(`floor: ${r.status}`);
    return (await r.json()) as Floor;
  }

  // The manager's timetable: the scheduled tasks the office runs for them.
  async schedule(): Promise<{ tasks: import('./timetable.ts').TimetableTask[] } | { error: string }> {
    try {
      const r = await fetch('/api/schedule', { headers: this.headers() });
      if (!r.ok) return { error: `refused (${r.status})` };
      return (await r.json()) as { tasks: import('./timetable.ts').TimetableTask[] };
    } catch {
      return { error: "couldn't reach the Mac" };
    }
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<{ ok: true } | { error: string }> {
    try {
      const r = await fetch(`/api/schedule/${encodeURIComponent(id)}`, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ enabled }) });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      return r.ok ? { ok: true } : { error: body.error ?? `refused (${r.status})` };
    } catch {
      return { error: "couldn't reach the Mac" };
    }
  }

  // The office's written happenings (Haiku's pool); [] when there are none or the Mac is away.
  async gags(): Promise<Gag[]> {
    try {
      const r = await fetch('/api/gags', { headers: this.headers() });
      if (!r.ok) return [];
      const list = ((await r.json()) as { gags?: unknown[] }).gags ?? [];
      return list.map(validGag).filter((g): g is Gag => !!g);
    } catch {
      return [];
    }
  }

  // The usage board: the usage meter's last reading for Claude and Codex (empty with no meter).
  async usage(): Promise<import('./topbar.ts').Meter[] | undefined> {
    try {
      const r = await fetch('/api/usage', { headers: this.headers() });
      return r.ok ? ((await r.json()) as { meters: import('./topbar.ts').Meter[] }).meters : undefined;
    } catch {
      return undefined;
    }
  }

  // The office's microphone: what the owner said, typed into the manager's chat. null: done; string: what went wrong.
  async say(text: string): Promise<string | null> {
    try {
      const r = await fetch('/api/say', { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ text }) });
      if (r.ok) return null;
      return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `refused (${r.status})`;
    } catch {
      return "couldn't reach the Mac";
    }
  }

  // The manager's whiteboard: their notebook as last written.
  async board(): Promise<{ notebook: string; updatedAt: number; jobs?: BoardJob[]; dismissed?: DismissedItem[]; goals?: Record<string, string>; office?: string[] } | { error: string }> {
    try {
      const r = await fetch('/api/board', { headers: this.headers() });
      if (!r.ok) return { error: `refused (${r.status})` };
      return (await r.json()) as { notebook: string; updatedAt: number; jobs?: BoardJob[]; dismissed?: DismissedItem[]; goals?: Record<string, string>; office?: string[] };
    } catch {
      return { error: "couldn't reach the Mac" };
    }
  }

  // Who has a running Claude session: "manager" for the manager, "lead:<room>" per project.
  // ...and the last thing each said (The manager's speech bubble).
  async sessions(): Promise<{ sessions: Record<string, 'busy' | 'idle'>; said: Record<string, { text: string; at: string; to?: string }>; waiting: Record<string, { kind: string; text: string }>; asks: Record<string, { id: string; question: string; more?: number; options?: string[]; tried?: string; password?: boolean; post?: string }>; lastDone?: number; deskUnread: number; coffee?: { at: number; who: { id: string; name: string; line: string }[] } }> {
    const r = await fetch('/api/sessions', { headers: this.headers() });
    if (r.status === 401 || r.status === 403) throw new AuthError(`sessions: ${r.status}`);
    if (!r.ok) throw new Error(`sessions: ${r.status}`); // the page keeps what it last knew
    const body = (await r.json()) as { sessions: Record<string, 'busy' | 'idle'>; said?: Record<string, { text: string; at: string; to?: string }>; waiting?: Record<string, { kind: string; text: string }>; asks?: Record<string, { id: string; question: string; more?: number; options?: string[]; tried?: string; password?: boolean; post?: string }>; lastDone?: number; deskUnread?: number; coffee?: { at: number; who: { id: string; name: string; line: string }[] } };
    return { sessions: body.sessions, said: body.said ?? {}, waiting: body.waiting ?? {}, asks: body.asks ?? {}, ...(body.lastDone ? { lastDone: body.lastDone } : {}), deskUnread: body.deskUnread ?? 0, ...(body.coffee ? { coffee: body.coffee } : {}) };
  }

  // The coffee room's board: what the rooms learned and shared.
  async coffeeRemove(id: string): Promise<string | null> {
    const r = await fetch(`/api/coffee/${encodeURIComponent(id)}/remove`, { method: 'POST', headers: this.headers() }).catch(() => null);
    if (!r) return "couldn't reach the Mac";
    return r.ok ? null : ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `refused (${r.status})`;
  }
  async coffee(): Promise<{ html: string; tips: number; list?: { id: string; kind: string; text: string; from: string; seen: number }[]; lastAt?: number; next?: number } | { error: string }> {
    try {
      const r = await fetch('/api/coffee', { headers: this.headers() });
      if (!r.ok) return { error: `refused (${r.status})` };
      return (await r.json()) as { html: string; tips: number; list?: { id: string; kind: string; text: string; from: string; seen: number }[]; lastAt?: number; next?: number };
    } catch {
      return { error: "couldn't reach the Mac" };
    }
  }

  // The owner's desk: the list of reports, and one report as a page (opening it marks it read).
  async desk(): Promise<{ reports: import('./desk.ts').DeskReport[] } | { error: string }> {
    try {
      const r = await fetch('/api/desk', { headers: this.headers() });
      if (!r.ok) return { error: `refused (${r.status})` };
      return (await r.json()) as { reports: import('./desk.ts').DeskReport[] };
    } catch {
      return { error: "couldn't reach the Mac" };
    }
  }
  async deskReport(id: string): Promise<(import('./desk.ts').DeskReport & { html: string }) | { error: string }> {
    try {
      const r = await fetch(`/api/desk/${encodeURIComponent(id)}`, { headers: this.headers() });
      if (!r.ok) return { error: r.status === 404 ? 'that report is gone' : `refused (${r.status})` };
      return (await r.json()) as import('./desk.ts').DeskReport & { html: string };
    } catch {
      return { error: "couldn't reach the Mac" };
    }
  }

  // The owner clicks Action on a whiteboard suggestion: the manager gets it to hand out.
  async boardAction(room: string, next: string): Promise<{ ok: true } | { error: string }> {
    const r = await fetch('/api/board/action', { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ room, next }) }).catch(() => null);
    if (!r) return { error: "Couldn't reach the Mac." };
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? { ok: true } : { error: body.error ?? `refused (${r.status})` };
  }

  // The owner sets (or clears, with '') a room's goal on the whiteboard; the manager is told.
  async boardGoal(folder: string, goal: string): Promise<{ ok: true } | { error: string }> {
    const r = await fetch('/api/board/goal', { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ folder, goal }) }).catch(() => null);
    if (!r) return { error: "Couldn't reach the Mac." };
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? { ok: true } : { error: body.error ?? `refused (${r.status})` };
  }

  // The owner clicks × on a whiteboard suggestion or job: not to be actioned; the manager is told.
  // undo: the owner brings it back from the Dismissed list.
  async boardDismiss(room: string, text: string, job?: string, undo = false): Promise<{ ok: true } | { error: string }> {
    const r = await fetch('/api/board/dismiss', { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ room, text, ...(job ? { job } : {}), ...(undo ? { undo: true } : {}) }) }).catch(() => null);
    if (!r) return { error: "Couldn't reach the Mac." };
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? { ok: true } : { error: body.error ?? `refused (${r.status})` };
  }

  // The owner answers a question over someone's head: yes / no, or the option they picked.
  async answer(id: string, answer: { yes: boolean } | { choice: number } | { signIn: true }): Promise<{ ok: true } | { error: string }> {
    const r = await fetch(`/api/asks/${encodeURIComponent(id)}`, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(answer) }).catch(() => null);
    if (!r) return { error: "Couldn't reach the Mac." };
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? { ok: true } : { error: body.error ?? `refused (${r.status})` };
  }

  // The owner picks the model for a room's Claude.
  async setModel(projectPath: string, model: string): Promise<{ applied: 'now' | 'next' } | { error: string }> {
    const r = await fetch('/api/model', { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ projectPath, model }) }).catch(() => null);
    if (!r) return { error: "Couldn't reach the Mac." };
    const body = (await r.json().catch(() => ({}))) as { applied?: 'now' | 'next'; error?: string };
    return r.ok && body.applied ? { applied: body.applied } : { error: body.error ?? `refused (${r.status})` };
  }

  // A terminal on a project's Claude Code session (joins the live one, or starts one).
  // `confirm`: the owner said yes on the phone (the daemon asks for it on every remote open).
  async openTerminal(projectPath: string, mode: 'join' | 'new' | 'resume', cols: number, rows: number, confirm = false): Promise<{ termId: string; session: string; fresh: boolean } | { error: string; confirm?: boolean }> {
    let r: Response;
    try {
      r = await fetch('/api/term/open', { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ projectPath, mode, cols, rows, ...(confirm ? { confirm: true } : {}) }) });
    } catch (err) {
      return { error: `couldn't reach the Mac (${String((err as Error)?.message ?? err)})` };
    }
    const body = (await r.json().catch(() => ({}))) as { termId?: string; session?: string; fresh?: boolean; error?: string; confirm?: boolean };
    if (!r.ok || !body.termId) return { error: body.error ?? `refused (${r.status})`, ...(body.confirm ? { confirm: true } : {}) };
    return { termId: body.termId, session: body.session ?? '', fresh: !!body.fresh };
  }

  termSend(termId: string, what: 'input' | 'resize' | 'close', body: Record<string, unknown> = {}): Promise<Response> {
    return fetch(`/api/term/${termId}/${what}`, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
  }

  // An image pasted or dropped on the terminal: the Mac saves it and pastes its path into Claude.
  termImage(termId: string, image: Blob): Promise<Response> {
    return fetch(`/api/term/${termId}/image`, { method: 'POST', headers: this.headers({ 'content-type': image.type }), body: image });
  }

  // Streams the terminal's output until it ends or `signal` aborts.
  async termStream(termId: string, onData: (chunk: string) => void, signal: AbortSignal): Promise<void> {
    const r = await fetch(`/api/term/${termId}/stream`, { headers: this.headers(), signal });
    if (!r.ok || !r.body) return;
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (frame.startsWith('event: exit')) return;
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) onData(JSON.parse(line.slice(6)) as string);
      }
    }
  }
}

// Something the owner dismissed on the whiteboard (they can bring it back).
export interface DismissedItem {
  room: string;
  text: string;
  job?: string;
  at: number;
}

// An open job on the whiteboard: what the owner asked for, in which room, and whether it's waiting on them.
export interface BoardJob {
  id: string;
  room: string;
  title: string;
  done: string;
  status: string;
  waitingFor?: string;
  holdFor?: string; // waiting on an outside event until holdUntil (not on the owner)
  holdUntil?: number;
}
