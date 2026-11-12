// Web addresses in the chat panel, for xterm's link provider: the links on one row, with ranges in
// terminal cells. A link that wraps onto the next row is found from either row, and wide or combining
// characters take the cells the terminal gives them, so a link lines up with what's on screen.

export interface Cell { getChars(): string; getWidth(): number }
export interface Line { isWrapped: boolean; length: number; getCell(x: number): Cell | undefined }
export interface Buffer { length: number; getLine(y: number): Line | undefined }
export interface TermLink { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string }

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;

// `y` is xterm's 1-based row.
export function linksOnRow(buf: Buffer, y: number): TermLink[] {
  // The whole logical line this row belongs to: back to its first row, on through its wrapped rows.
  let top = y - 1;
  while (top > 0 && buf.getLine(top)?.isWrapped) top--;
  if (!buf.getLine(top)) return [];
  let text = '';
  const at: { x: number; y: number; w: number }[] = []; // each character's cell (1-based)
  for (let row = top; row < buf.length && (row === top || buf.getLine(row)?.isWrapped); row++) {
    const line = buf.getLine(row)!;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // the second half of a wide character
      const ch = cell.getChars() || ' ';
      for (let c = 0; c < ch.length; c++) at.push({ x: x + 1, y: row + 1, w: cell.getWidth() });
      text += ch;
    }
  }
  const out: TermLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const a = at[m.index!]!;
    const b = at[m.index! + m[0].length - 1]!;
    if (b.y < y || a.y > y) continue; // not on the row asked about
    out.push({ range: { start: { x: a.x, y: a.y }, end: { x: b.x + b.w - 1, y: b.y } }, text: m[0] });
  }
  return out;
}
