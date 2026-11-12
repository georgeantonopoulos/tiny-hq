// Office sounds: tiny 8-bit chimes made in the browser (no audio files), quiet and rare.
// Different ones for alerts and questions, plus a few fun ones, never overdone, matching the look,
// with an easy off switch. On by default, quiet.
//
// Rules that keep it from being too much:
// - one sound at a time: at most one every 10 s, and news ("!") at most once a minute;
// - never for working dots or anything already up when the page opens (the page arms it after
//   its first look);
// - browsers allow sound only after a first click on the page, so nothing plays before that;
// - the speaker switch next to the mic mutes everything, remembered per device.

export type Cue = 'message' | 'question' | 'done' | 'whimsy' | 'micOn' | 'micOff';

type Note = { f: number; at: number; len: number; wave?: OscillatorType; gain?: number; slide?: number };

// Each cue: a few notes (Hz, start s, length s). Square and triangle waves for the pixel-art feel.
export const CUES: Record<Cue, Note[]> = {
  // "!": a soft two-note blip, up a fourth.
  message: [
    { f: 784, at: 0, len: 0.08, wave: 'triangle' },
    { f: 1047, at: 0.09, len: 0.12, wave: 'triangle' },
  ],
  // "?": three rising notes, a little brighter, so a question stands out from news.
  question: [
    { f: 659, at: 0, len: 0.09, wave: 'square', gain: 0.5 },
    { f: 784, at: 0.1, len: 0.09, wave: 'square', gain: 0.5 },
    { f: 988, at: 0.2, len: 0.16, wave: 'square', gain: 0.5 },
  ],
  // A job finished: a happy little run up a major chord.
  done: [
    { f: 523, at: 0, len: 0.07, wave: 'triangle' },
    { f: 659, at: 0.07, len: 0.07, wave: 'triangle' },
    { f: 784, at: 0.14, len: 0.07, wave: 'triangle' },
    { f: 1047, at: 0.21, len: 0.2, wave: 'triangle' },
  ],
  // A happening on the floor: a quiet comic "boing" (a sliding note).
  whimsy: [{ f: 330, at: 0, len: 0.22, wave: 'triangle', gain: 0.6, slide: 660 }],
  // The mic: a soft click on, a lower one off.
  micOn: [{ f: 1200, at: 0, len: 0.03, wave: 'square', gain: 0.35 }],
  micOff: [{ f: 700, at: 0, len: 0.03, wave: 'square', gain: 0.35 }],
};

export const VOLUME = 0.12; // quiet: well under a system alert
export const MIN_GAP_MS = 10_000;
export const NEWS_GAP_MS = 60_000;
const KEY = 'cm-sound'; // 'off' when muted

// When a cue may play, given what played last. Mic clicks answer the owner's own press: always.
export function allowed(cue: Cue, now: number, last: { any: number; news: number }): boolean {
  if (cue === 'micOn' || cue === 'micOff') return true;
  if (now - last.any < MIN_GAP_MS) return false;
  if (cue === 'message' && now - last.news < NEWS_GAP_MS) return false;
  return true;
}

export class Sound {
  #ctx: AudioContext | undefined;
  #armed = false;
  #last = { any: 0, news: 0 };
  #on: boolean;

  constructor() {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* private window: default on */
    }
    this.#on = saved !== 'off';
    // Browsers allow sound only after the first click or key on the page.
    const unlock = () => {
      this.#context()?.resume().catch(() => undefined);
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  get on(): boolean {
    return this.#on;
  }

  set on(v: boolean) {
    this.#on = v;
    try {
      localStorage.setItem(KEY, v ? 'on' : 'off');
    } catch {
      /* not remembered: fine */
    }
  }

  // After the page's first look: from now on, only new things make a sound.
  arm(): void {
    this.#armed = true;
  }

  play(cue: Cue): void {
    if (!this.#on) return;
    const user = cue === 'micOn' || cue === 'micOff';
    if (!user && !this.#armed) return;
    const now = Date.now();
    if (!allowed(cue, now, this.#last)) return;
    const ctx = this.#context();
    if (!ctx) return;
    // The owner's own press wakes the audio up if it's still asleep; anything else waits for a first click.
    if (ctx.state !== 'running') {
      if (user && ctx.state === 'suspended') void ctx.resume().then(() => this.#notes(ctx, cue)).catch(() => undefined);
      return;
    }
    if (!user) {
      this.#last.any = now;
      if (cue === 'message') this.#last.news = now;
    }
    this.#notes(ctx, cue);
  }

  #notes(ctx: AudioContext, cue: Cue): void {
    const t0 = ctx.currentTime + 0.01;
    for (const n of CUES[cue]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.wave ?? 'square';
      osc.frequency.setValueAtTime(n.f, t0 + n.at);
      if (n.slide) osc.frequency.exponentialRampToValueAtTime(n.slide, t0 + n.at + n.len);
      const peak = VOLUME * (n.gain ?? 1);
      // A tiny attack and a soft tail, so nothing clicks harshly.
      g.gain.setValueAtTime(0.0001, t0 + n.at);
      g.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.len + 0.02);
    }
  }

  #context(): AudioContext | undefined {
    if (this.#ctx) return this.#ctx;
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return undefined;
    this.#ctx = new AC();
    return this.#ctx;
  }
}

// The speaker switch next to the mic.
export function wireSoundSwitch(btn: HTMLButtonElement, sound: Sound): void {
  const show = () => {
    btn.classList.toggle('muted', !sound.on);
    btn.setAttribute('aria-pressed', String(sound.on));
    btn.title = sound.on ? 'Office sounds on (click to mute)' : 'Office sounds off (click to turn on)';
  };
  btn.addEventListener('click', () => {
    sound.on = !sound.on;
    show();
    if (sound.on) sound.play('micOn'); // a little click so they hear it's on
  });
  show();
}
