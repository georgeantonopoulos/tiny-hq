// Used by manager/delegate before it starts a session:
//   on-call.ts may-start <folder>   exit 0 if the office may start a session there, 5 if not
// An on-call room (onCallProjects in the office config) starts only for an open job the owner gave it;
// the owner's own clicks skip this check (the office sets CM_FROM_OWNER). Without it, the manager
// acting on a timetable result or a whiteboard idea could start a paid session there.

import { loadConfig } from '../config.ts';
import { CONFIG_PATH, MANAGER_NOTES_DIR } from '../paths.ts';
import { jobsPath, loadJobs } from '../team/jobs.ts';
import { isOnCall } from '../office/on-call.ts';

const [cmd, folder] = process.argv.slice(2);
if (cmd !== 'may-start' || !folder) {
  console.error('usage: on-call.ts may-start <folder>');
  process.exit(2);
}
const onCall = loadConfig(process.env.CM_CONFIG_PATH ?? CONFIG_PATH).onCallProjects;
if (!isOnCall(folder, onCall)) process.exit(0);
const jobs = loadJobs(process.env.CM_JOBS_PATH ?? jobsPath(MANAGER_NOTES_DIR));
const room = onCall.find((p) => isOnCall(folder, [p]))!;
if (jobs.some((j) => j.status !== 'done' && isOnCall(j.room, [room]))) process.exit(0);
console.error(
  `delegate: ${folder} is an on-call room: it starts only when the owner asks it something (their click on the floor) or for an open job the owner gave it (manager/job add). Nothing was started.`,
);
process.exit(5);
