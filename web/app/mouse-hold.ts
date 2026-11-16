// Keeps a mouse drag reaching Claude Code while the button is held.
//
// Claude Code re-sends its mouse settings ("ESC[?1000h ESC[?1002h ESC[?1003h") when the chat
// panel gains focus, which happens on the press that starts a selection. xterm.js treats each
// of those as a switch: the first drops it to click-only tracking, which unhooks its drag
// listener, and the later ones bring the mode back without hooking it up again until the next
// press. The rest of the drag never reaches Claude Code, so it selects (and copies) only the
// word under the press.
//
// While a button is held, a request for a mouse mode no higher than the current one is
// dropped: it changes nothing once the burst finishes, and the drag listener stays hooked.

export type MouseMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

const RANK: Record<MouseMode, number> = { none: 0, x10: 1, vt200: 2, drag: 3, any: 4 };
// DECSET numbers for the mouse tracking modes (encodings like 1006 are not tracking modes).
const MODE_OF: Record<number, MouseMode> = { 9: 'x10', 1000: 'vt200', 1002: 'drag', 1003: 'any' };

/** True when a DECSET ("ESC[?…h") should be swallowed: every number in it is a mouse tracking
 * mode no higher than the current one, and a mouse button is held. Anything else goes through. */
export function dropMouseModeSet(params: readonly (number | number[])[], current: MouseMode, held: boolean): boolean {
  if (!held || !params.length) return false;
  return params.every((p) => {
    const mode = typeof p === 'number' ? MODE_OF[p] : undefined;
    return !!mode && RANK[mode] <= RANK[current];
  });
}

let held = false;
let watching = false;
/** Starts following whether a mouse button is down anywhere on the page (once per page). */
export function watchMouseHeld(): void {
  if (watching) return;
  watching = true;
  const update = (e: MouseEvent) => { held = e.buttons !== 0; };
  document.addEventListener('mousedown', update, true);
  document.addEventListener('mouseup', update, true);
  window.addEventListener('blur', () => { held = false; });
}
export function mouseHeld(): boolean {
  return held;
}
