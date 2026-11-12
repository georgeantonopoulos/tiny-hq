// Typing on a phone. xterm.js reads a phone keyboard through several paths at
// once (composition end, keydown 229, input events) and clears its hidden text
// box on Enter and blur. Swipe typing and autocorrect rewrite that box in ways
// those paths disagree on, so words arrive twice, stray letters slip in, and a
// composition that lost its place re-sends the whole box (the whole prompt).
//
// On touch screens we own the box instead: whatever the keyboard leaves in it is
// compared with what Claude already has, and only the difference goes over
// (backspaces for what changed, then the new text). One path, so nothing can be
// sent twice. Keys a phone keyboard doesn't type into the box (arrows, Esc, Tab,
// Ctrl combos from a hardware keyboard) still go to xterm as before.

// What to send to turn `sent` into `now`, given the cursor is at the end:
// a backspace per character from the first difference on, then the rest of `now`.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function typedDiff(sent: string, now: string): string {
  if (sent === now) return '';
  let i = 0;
  while (i < sent.length && i < now.length && sent[i] === now[i]) i++;
  // Back up to the start of a whole character, so an emoji (flag, skin tone, family) is never split.
  let start = 0;
  let removed = 0;
  for (const g of graphemes.segment(sent)) {
    if (g.index + g.segment.length <= i) start = g.index + g.segment.length;
    else removed++;
  }
  return '\x7f'.repeat(removed) + now.slice(start).replace(/\r?\n/g, '\r');
}

const plain = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey;

export function phoneTyping(host: HTMLElement, send: (d: string) => void): () => void {
  if (!matchMedia('(pointer: coarse)').matches) return () => undefined;
  let sent = ''; // the part of the box Claude already has
  const box = (e: Event) => {
    const t = e.target;
    return t instanceof HTMLTextAreaElement && t.classList.contains('xterm-helper-textarea') ? t : null;
  };
  const sync = (ta: HTMLTextAreaElement) => {
    const d = typedDiff(sent, ta.value);
    sent = ta.value;
    if (d) send(d);
  };
  // xterm may change the box itself (it empties it on Ctrl+C and on blur): take that as the new start.
  const resync = (ta: HTMLTextAreaElement) => setTimeout(() => (sent = ta.value), 0);

  const keydown = (e: KeyboardEvent) => {
    const ta = box(e);
    if (!ta) return;
    if (e.isComposing || e.keyCode === 229) return e.stopImmediatePropagation(); // the keyboard is writing into the box
    if (e.key === 'Enter' && plain(e)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      sync(ta);
      send('\r');
      ta.value = '';
      sent = '';
      return;
    }
    if (e.key === 'Backspace' && plain(e) && ta.selectionStart > 0) return e.stopImmediatePropagation(); // the box loses a letter; the input event sends it
    if (e.key.length === 1 && plain(e)) return e.stopImmediatePropagation(); // a letter: it lands in the box
    resync(ta); // anything else is xterm's
  };
  const keypress = (e: KeyboardEvent) => {
    if (box(e) && e.key.length === 1 && plain(e)) e.stopImmediatePropagation();
  };
  const input = (e: Event) => {
    const ta = box(e);
    if (!ta) return;
    e.stopImmediatePropagation();
    const ie = e as InputEvent;
    // xterm already sent a paste (or drop) itself: what landed in the box is the new start.
    if (ie.inputType?.startsWith('insertFromPaste') || ie.inputType?.startsWith('insertFromDrop')) {
      sent = ta.value;
      return;
    }
    sync(ta);
    // Enter arrived as a new line in the box: that prompt is gone, start the next one empty.
    if (ta.value.includes('\n')) {
      ta.value = '';
      sent = '';
    }
  };
  const composition = (e: Event) => {
    const ta = box(e);
    if (!ta) return;
    e.stopImmediatePropagation();
    if (e.type === 'compositionend') sync(ta);
  };
  const focus = (e: Event) => {
    const ta = box(e);
    if (ta) resync(ta);
  };

  const events: [string, EventListener][] = [
    ['keydown', keydown as EventListener],
    ['keypress', keypress as EventListener],
    ['input', input],
    ['compositionstart', composition],
    ['compositionupdate', composition],
    ['compositionend', composition],
    ['focus', focus],
    ['blur', focus],
  ];
  // Capture on the panel runs before xterm's own listeners on the box.
  for (const [type, fn] of events) host.addEventListener(type, fn, true);
  return () => {
    for (const [type, fn] of events) host.removeEventListener(type, fn, true);
  };
}
