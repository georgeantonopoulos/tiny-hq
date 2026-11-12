// manager/schedule: how the manager manages the office timetable (the office runs the tasks).
//   schedule list
//   schedule add <id> "<title>" (--daily HH:MM | --every N[h] [--minute M]) [--until YYYY-MM-DD] -- "<prompt>"
//   schedule enable|disable|remove <id>
// Writes ~/.tiny-hq/manager/schedule.json; the owner sees it on the timetable in the manager's office.

import { MANAGER_NOTES_DIR } from '../paths.ts';
import { describeWhen, loadSchedule, nextSlot, saveSchedule, schedulePath, validTask, type Task } from '../team/schedule.ts';

const path = schedulePath(MANAGER_NOTES_DIR);
const [cmd, ...rest] = process.argv.slice(2);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
const tasks = loadSchedule(path);
const fmt = (d: Date) => d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

switch (cmd) {
  case 'list':
  case undefined: {
    if (!tasks.length) console.log('No scheduled tasks.');
    for (const t of tasks)
      console.log(`${t.enabled ? 'on ' : 'off'}  ${t.id}  ${t.title}  ·  ${describeWhen(t.when)}${t.until ? ` until ${t.until}` : ''}  ·  next ${fmt(nextSlot(t.when, new Date()))}${t.lastRun ? `  ·  last ${fmt(new Date(t.lastRun))}` : ''}`);
    break;
  }
  case 'add': {
    const sep = rest.indexOf('--');
    if (sep < 0) fail('usage: schedule add <id> "<title>" (--daily HH:MM | --every N [--minute M]) [--until YYYY-MM-DD] -- "<prompt>"');
    const [id, title, ...opts] = rest.slice(0, sep);
    const prompt = rest.slice(sep + 1).join(' ');
    const opt = (name: string) => {
      const i = opts.indexOf(name);
      return i >= 0 ? opts[i + 1] : undefined;
    };
    const daily = opt('--daily');
    const every = opt('--every');
    const when = daily ? { daily } : every ? { everyHours: Number(every.replace(/h$/, '')), minute: Number(opt('--minute') ?? 0) } : undefined;
    const t = validTask({ id, title, when, prompt, enabled: true, until: opt('--until'), since: Date.now(), createdBy: 'Manager' });
    if (!t) fail('Not added: check the id (lowercase-with-dashes), the time (HH:MM, or --every 1-24), and that there is a title and a prompt.');
    if (t!.id === 'daily-brief') fail('daily-brief belongs to the office; the owner switches it on or off on the timetable.');
    const next: Task[] = [...tasks.filter((x) => x.id !== t!.id), t!];
    saveSchedule(path, next);
    console.log(`${tasks.some((x) => x.id === t!.id) ? 'Updated' : 'Added'} ${t!.id}: ${describeWhen(t!.when)}, next ${fmt(nextSlot(t!.when, new Date()))}.`);
    break;
  }
  case 'enable':
  case 'disable':
  case 'remove': {
    const id = rest[0];
    const t = tasks.find((x) => x.id === id);
    if (!t) fail(`No task called "${id}". Try: schedule list`);
    if (cmd === 'remove' && id === 'daily-brief') fail('daily-brief belongs to the office; disable it instead.');
    const next = cmd === 'remove' ? tasks.filter((x) => x.id !== id) : tasks.map((x) => (x.id === id ? { ...x, enabled: cmd === 'enable', ...(cmd === 'enable' && !x.enabled ? { since: Date.now() } : {}) } : x));
    saveSchedule(path, next);
    console.log(`${cmd === 'remove' ? 'Removed' : cmd === 'enable' ? 'Switched on' : 'Switched off'}: ${id}`);
    break;
  }
  default:
    fail('usage: schedule list | add ... | enable <id> | disable <id> | remove <id>');
}
