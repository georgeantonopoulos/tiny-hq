// tiny-hq disk-tidy: the build folders the office would clear when the disk runs low (src/team/disk-tidy.ts).
//   tiny-hq disk-tidy            dry run: every build folder, its size, and why it stays or could go
//   tiny-hq disk-tidy --apply    clear every idle one now (not just enough to get back over the line)
import { CONFIG_PATH, DATA_DIR } from '../paths.ts';
import { loadConfig } from '../config.ts';
import { addTidyLog, busyFolders, clear, ENOUGH_GB, freeBytes, gb, LOW_GB, projectsIn, survey, tidyLogPath } from '../team/disk-tidy.ts';

export async function diskTidy(args: string[]): Promise<number> {
  const config = loadConfig(CONFIG_PATH);
  const apply = args.includes('--apply');
  const before = freeBytes();
  let busy: string[];
  try {
    busy = await busyFolders();
  } catch (err) {
    console.log(`Couldn't tell which projects have a session working in them, so nothing is listed or cleared: ${String(err).slice(0, 200)}`);
    return 1;
  }
  const all = survey(projectsIn(config.projectRoots, config.extraProjects), busy, Date.now(), undefined, true).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  console.log(
    config.extras.diskTidy
      ? `Free now: ${gb(before)}. Disk tidy is on: the office clears idle build folders under ${LOW_GB} GB free, until ${ENOUGH_GB} GB.`
      : `Free now: ${gb(before)}. Disk tidy is off, so the office never clears these by itself (switch it on with tiny-hq setup, or "diskTidy": true under extras in ${CONFIG_PATH}).`,
  );
  for (const c of all) console.log(`${gb(c.bytes ?? 0).padStart(9)}  ${c.keep ? `stays (${c.keep})` : 'could go'}  ${c.path}`);
  const go = all.filter((c) => !c.keep);
  console.log(`Idle, could go: ${go.length} folders, ${gb(go.reduce((n, c) => n + (c.bytes ?? 0), 0))}.${apply || !go.length ? '' : ' Run with --apply to clear them now.'}`);
  if (apply && go.length) {
    const cleared = await clear(go);
    const after = freeBytes();
    addTidyLog(tidyLogPath(DATA_DIR), { at: Date.now(), freeBefore: before, freeAfter: after, cleared });
    console.log(`Cleared ${cleared.length}. Free: ${gb(before)} → ${gb(after)}.`);
  }
  return 0;
}
