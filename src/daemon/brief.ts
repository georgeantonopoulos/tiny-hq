// The manager's daily brief: the office's own task on their timetable (src/team/schedule.ts),
// first set from config "briefingTime" (default 08:30). What they do with it lives
// in manager/CLAUDE.md ("Daily brief"), so it can change without touching code.

// Points at the file, not "your CLAUDE.md": a long-running session read that file
// when it started and wouldn't see later changes to the brief.
export const BRIEF_PROMPT = 'Daily brief: read the "Email: confirm it yourself" and "Daily brief" sections of ~/.tiny-hq/app/manager/CLAUDE.md, then do the brief.';

// "HH:MM" in local time, or undefined when the setting is missing or malformed.
export function parseTime(v: unknown): string | undefined {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined;
}
