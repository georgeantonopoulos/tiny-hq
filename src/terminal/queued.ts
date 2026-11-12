// Did a line typed into a Claude Code session land? An idle session writes it to its
// transcript at once; a busy one first writes only "a message was queued" (no text) and
// the line itself when it gets to it, which can be minutes later.

// A "queued a message" line in `text`, from byte `from` on (what was written after our Enter).
export function queuedAfter(text: string, from: number): boolean {
  return Buffer.from(text, 'utf8')
    .subarray(Math.max(0, from))
    .toString('utf8')
    .split('\n')
    .some((l) => l.includes('"type":"queue-operation"') && l.includes('"operation":"enqueue"'));
}
