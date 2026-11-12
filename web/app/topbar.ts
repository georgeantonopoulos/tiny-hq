// The top bar's two tools: the usage board (how much of the Claude and Codex allowances
// is used, per 5-hour and weekly window, and when each resets) and the office's one
// microphone for talking to the manager (Claude Code's own push-to-talk, on the Mac).

export interface Meter {
  provider: 'claude' | 'codex';
  fiveHour?: { used: number; resetsAt?: number };
  week?: { used: number; resetsAt?: number };
  at: number;
  stale: boolean;
}

const NAMES = { claude: 'Claude', codex: 'Codex' } as const;

// "in 2h 10m" today, "Wed 10:00" later.
export function resetText(at: number | undefined, now = Date.now()): string {
  if (!at) return '';
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return 'resetting now';
  if (mins < 60) return `resets in ${mins}m`;
  if (mins < 12 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `resets ${new Date(at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

const level = (used: number) => (used >= 90 ? 'high' : used >= 70 ? 'mid' : 'low');

function gauge(label: string, w: { used: number; resetsAt?: number } | undefined): HTMLElement {
  const g = document.createElement('span');
  g.className = 'gauge';
  if (!w) {
    g.textContent = `${label} –`;
    return g;
  }
  const bar = document.createElement('span');
  bar.className = `bar ${level(w.used)}`;
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, w.used)}%`;
  bar.append(fill);
  const num = document.createElement('b');
  num.textContent = `${Math.round(w.used)}%`;
  const reset = document.createElement('small');
  reset.textContent = resetText(w.resetsAt);
  g.append(`${label} `, bar, ' ', num, ' ', reset);
  g.title = `${label} window: ${Math.round(w.used)}% used${w.resetsAt ? `, ${resetText(w.resetsAt)}` : ''}`;
  return g;
}

export function renderUsage(el: HTMLElement, meters: Meter[] | undefined): void {
  // No usage meter set up (or not read yet): the board stays empty rather than promising numbers.
  el.hidden = !meters?.length;
  if (!meters?.length) {
    el.replaceChildren();
    return;
  }
  el.replaceChildren(
    ...meters.map((m) => {
      const row = document.createElement('div');
      row.className = `meter${m.stale ? ' stale' : ''}`;
      const name = document.createElement('strong');
      name.textContent = NAMES[m.provider];
      row.append(name, gauge('5h', m.fiveHour), gauge('week', m.week));
      if (m.stale) row.title = `Last read ${new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}: the usage meter hasn't answered since`;
      return row;
    }),
  );
}

// The microphone. Hold it to talk (let go to send), or tap once to start and tap again to send.
// The browser's own speech recognition writes the words down as the owner speaks (shown in the top
// bar), and when they let go they go into the manager's chat. Nothing is sent if nothing was heard.
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
export function recognitionClass(w: object = globalThis): (new () => Recognition) | undefined {
  const o = w as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return o.SpeechRecognition ?? o.webkitSpeechRecognition;
}

// The words heard so far: final pieces plus the one still being heard.
export function heard(results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>): string {
  const tidy = (t: string) => t.replace(/\s+/g, ' ').trim();
  let text = '';
  for (let i = 0; i < results.length; i++) {
    const t = results[i]![0]?.transcript ?? '';
    // Some browsers (Chrome on Android) repeat everything said so far in each new result.
    text = text && tidy(t).toLowerCase().startsWith(tidy(text).toLowerCase()) ? t : text + t;
  }
  return tidy(text);
}

// Up to what the office takes in one message.
export const MAX_SAY = 4000;

const MIC_ERRORS: Record<string, string> = {
  'not-allowed': 'the browser has no microphone permission for the office page (allow it in the address bar)',
  'service-not-allowed': 'the browser has no microphone permission for the office page (allow it in the address bar)',
  'audio-capture': 'no microphone found (is it muted, or unplugged?)',
  network: "the browser's speech service couldn't be reached",
};

export function wireMic(btn: HTMLButtonElement, send: (text: string) => Promise<string | null>, note: (text: string) => void, click: (on: boolean) => void = () => undefined): void {
  const Rec = recognitionClass();
  // Browsers only lend the microphone to secure pages; the phone reaches the office over plain
  // http on Tailscale (its certificate couldn't be issued), so say that instead of a wrong reason.
  if (Rec && !globalThis.isSecureContext) {
    btn.addEventListener('click', () => note("Voice needs the office's https address; on the phone it's plain http for now, so the browser won't lend the mic"));
    btn.title = "Voice needs a secure (https) link to the office";
    btn.classList.add('off');
    return;
  }
  if (!Rec) {
    btn.disabled = true;
    btn.title = "This browser can't turn speech into text (use Chrome or Safari)";
    return;
  }
  // One press: held or latched until the owner lets go. The browser may stop listening by itself
  // (a pause, or always on some phones); while the press lasts it is started again, and the words
  // gathered so far are kept. Only letting go sends; a cancelled press sends nothing.
  let pressed = false;
  let latched = false; // tapped: stays on until the next tap
  let cancelled = false;
  let rec: Recognition | undefined;
  let before = ''; // words from earlier rounds of this press
  let now = ''; // words from the round under way
  let failed = '';
  let downAt = 0;
  const words = () => `${before} ${now}`.replace(/\s+/g, ' ').trim();
  const show = () => {
    btn.classList.toggle('live', pressed);
    btn.setAttribute('aria-pressed', String(pressed));
    btn.title = pressed ? 'Listening. Let go, or tap again, to send it to the manager.' : 'Talk to the manager: hold to talk and let go to send, or tap to start and tap again to send';
  };
  const finish = () => {
    click(false);
    const w = words().slice(0, MAX_SAY);
    const cut = words().length > MAX_SAY;
    before = '';
    now = '';
    if (cancelled) return note('Mic: cancelled, nothing sent');
    if (failed) return note(`Mic: ${failed}`);
    if (!w) return note("Mic: didn't catch anything");
    note(`Sending to the manager: “${w}”`);
    void send(w).then((err) => note(err ? `Mic: ${err} (what you said: “${w}”)` : `Sent to the manager${cut ? ' (the first 4000 characters)' : ''}: “${w}”`));
  };
  const listen = () => {
    const r = new Rec();
    r.lang = navigator.language || 'en-GB';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      if (rec !== r) return;
      now = heard(e.results);
      note(`Listening… ${words()}`);
    };
    r.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') failed = MIC_ERRORS[e.error] ?? e.error;
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = undefined;
      before = words();
      now = '';
      // Stopped by itself while they're still talking: listen again (unless something is wrong).
      if (pressed && !failed && !cancelled) return listen();
      pressed = false;
      latched = false;
      show();
      finish();
    };
    rec = r;
    try {
      r.start();
    } catch (err) {
      rec = undefined;
      failed = `the microphone wouldn't start (${String((err as Error)?.message ?? err).slice(0, 80)})`;
      pressed = false;
      latched = false;
      show();
      finish();
    }
  };
  const start = () => {
    if (pressed || rec) return; // still finishing the last press
    pressed = true;
    click(true);
    cancelled = false;
    failed = '';
    before = '';
    now = '';
    show();
    note('Listening… (let go to send)');
    listen();
  };
  const end = (cancel = false) => {
    if (!pressed) return;
    pressed = false;
    latched = false;
    cancelled = cancel;
    show();
    if (rec) {
      if (cancel) rec.abort();
      else rec.stop(); // onend sends it, with the last words
    } else finish();
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // right-click or ctrl-click: not a press
    e.preventDefault();
    if (latched) return end();
    if (pressed || rec) return;
    btn.setPointerCapture(e.pointerId);
    downAt = Date.now();
    start();
  });
  const release = () => {
    if (!pressed || latched) return;
    // A quick tap: keep listening until the next tap.
    if (Date.now() - downAt < 350) latched = true;
    else end();
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('lostpointercapture', release);
  btn.addEventListener('pointercancel', () => end(true));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  show();
}
