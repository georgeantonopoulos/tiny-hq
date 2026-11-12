// The manager's notebook, split into one section per project, for the whiteboard.
// No page code here, so the tests can use it too.

import type { Room } from '../../src/office/layout.ts';

export interface Section {
  title: string;
  lines: string[];
}

// "## Website (Rosa)" + its "- " bullets.
export function parseNotebook(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | undefined;
  for (const raw of md.split('\n')) {
    const h = /^##\s+(.+)$/.exec(raw);
    if (h) {
      cur = { title: h[1]!.trim(), lines: [] };
      out.push(cur);
      continue;
    }
    const b = /^\s*[-*]\s+(.+)$/.exec(raw);
    if (cur && b) cur.lines.push(b[1]!.trim());
  }
  return out;
}

// The notebook section about this room: its heading starts with the room's name or names its lead.
export function sectionFor(room: Room, sections: Section[]): Section | undefined {
  const name = room.name.toLowerCase();
  const lead = room.lead?.name.toLowerCase();
  return sections.find((s) => {
    const t = s.title.toLowerCase();
    return t.startsWith(name) || (!!lead && t.includes(`(${lead})`));
  });
}

// One whiteboard item the owner dismissed, matched even if the manager rewrites its punctuation or case a little.
export function dismissKey(room: string, text: string): string {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(room)}\n${norm(text)}`;
}
