// manager/job: the open jobs the office keeps moving (see src/team/jobs.ts).
//   job list
//   job add <id> "<project folder>" "<title>" --done "<what finished looks like>"
//   job wait <id> "<the one thing the owner must do>" --why <reason> --tried "<what was tried>"   (the office stops nudging)
//   job hold <id> "<what we're waiting for>" --until <time>   (waiting on an outside event, not The owner: no nudges, no button, resumes by itself)
//   job go <id>                                       (The owner did their part: back on)
//   job show <id>                                     (the job and its brief)
//   job note <id> "<what happened>"                   (a dated Progress line in the brief)
//   job done <id>
//   job remove <id>
// Writes ~/.tiny-hq/manager/jobs.json.

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MANAGER_NOTES_DIR } from '../paths.ts';
import { checkOnlyOwner, takeOnlyOwner } from '../team/only-owner.ts';
import { addAsk, asksPath, loadAsks, saveAsks } from '../team/asks.ts';
import { holdWatch, holdWatchId, loadSchedule, saveSchedule, schedulePath } from '../team/schedule.ts';
import { briefPath, briefTemplate, describeJobs, emptySections, jobsPath, loadJobs, parseUntil, saveJobs, validJob, type Job } from '../team/jobs.ts';

const path = jobsPath(MANAGER_NOTES_DIR);
const [cmd, ...rest] = process.argv.slice(2);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
const jobs = loadJobs(path);
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const find = (id: string | undefined): Job => jobs.find((j) => j.id === id) ?? fail(`No job called "${id}". Try: job list`);
const put = (j: Job) => saveJobs(path, [...jobs.filter((x) => x.id !== j.id), j]);
// A held job's own watch on the timetable (src/team/schedule.ts holdWatch).
const SCHEDULE = schedulePath(MANAGER_NOTES_DIR);
const JOB_CLI = resolve(dirname(process.argv[1] ?? '.'), '../../manager/job');
const dropWatch = (id: string) => {
  const tasks = loadSchedule(SCHEDULE);
  if (tasks.some((t) => t.id === holdWatchId(id))) saveSchedule(SCHEDULE, tasks.filter((t) => t.id !== holdWatchId(id)));
};

switch (cmd) {
  case 'list':
  case undefined:
    console.log(describeJobs(jobs, base));
    break;
  case 'add': {
    const i = rest.indexOf('--done');
    if (i < 0) fail('usage: job add <id> "<project folder>" "<title>" --done "<what finished looks like>"');
    const [id, folder, title] = rest.slice(0, i);
    const done = rest.slice(i + 1).join(' ');
    let room = '';
    try {
      room = realpathSync(resolve(folder ?? ''));
    } catch {
      fail(`No such folder: ${folder}`);
    }
    const old = jobs.find((x) => x.id === id);
    const j = validJob({ id, room, title, done, status: 'active', createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now() });
    if (!j) fail('Not added: check the id (lowercase-with-dashes), the folder, a title and a --done line.');
    put(j!);
    const bp = briefPath(MANAGER_NOTES_DIR, j!.id);
    if (!existsSync(bp)) {
      mkdirSync(dirname(bp), { recursive: true, mode: 0o700 });
      writeFileSync(bp, briefTemplate(j!), { mode: 0o600 });
    }
    console.log(`${old ? 'Updated' : 'Added'} ${j!.id} in ${base(room)}. The office will keep it moving until: job done ${j!.id}`);
    const empty = emptySections(readFileSync(bp, 'utf8'));
    if (empty.length) console.log(`Brief: ${bp}\nFill in before you hand it over (Write tool): ${empty.join(', ')}. Then tell the room: "Job ${j!.id}: read ${bp} first."`);
    break;
  }
  case 'wait': {
    const proof = takeOnlyOwner(rest);
    const j = find(proof.rest[0]);
    const what = proof.rest.slice(1).join(' ').trim();
    if (!what) fail('usage: job wait <id> "<the one thing the owner must do>" --why <reason> --tried "<what was tried>"');
    // Only the owner's things reach the owner (src/team/only-owner.ts).
    const refused = checkOnlyOwner(proof.why, proof.tried);
    if (refused) fail(`Not waiting on the owner: ${j.id} stays active.\n${refused}`);
    const { holdFor: _hf, holdUntil: _hu, ...unheld } = j;
    dropWatch(j.id);
    put({ ...unheld, status: 'waiting', waitingFor: what.slice(0, 300), updatedAt: Date.now(), lastNudge: undefined, nudgesToday: 0 });
    // The owner never types commands or chats for a yes: it's a button over the room lead's head.
    let folder = j.room;
    try {
      folder = realpathSync(j.room);
    } catch {
      /* keep as written */
    }
    const asks = addAsk(loadAsks(asksPath(MANAGER_NOTES_DIR)), folder, what, Date.now(), undefined, undefined, j.id, undefined, false, undefined, { why: proof.why!.trim().toLowerCase(), tried: proof.tried! });
    saveAsks(asksPath(MANAGER_NOTES_DIR), asks);
    const rides = asks.find((a) => a.forJob === j.id);
    if (rides) {
      console.log(`${j.id} is waiting on the owner: ${what}. The room already has its own question over its head ("${rides.question.slice(0, 80)}"), so the owner sees only that one; their answer goes to the room and puts the job back to work. Don't also ask them in chat. The office checks every 15 minutes whether it's done; when it is: job go ${j.id}`);
      break;
    }
    console.log(`${j.id} is waiting on the owner: ${what}. The owner sees it as an Approve / No button over the room's head; Approve is typed into the room's chat and puts the job back to work. Don't also ask them in chat. The office checks every 15 minutes whether it's done; when it is: job go ${j.id}`);
    break;
  }
  case 'hold': {
    const j = find(rest[0]);
    const i = rest.indexOf('--until');
    const what = (i < 0 ? rest.slice(1) : rest.slice(1, i)).join(' ').trim();
    const until = i < 0 ? undefined : parseUntil(rest.slice(i + 1).join(' '), Date.now());
    if (!what || i < 0) fail('usage: job hold <id> "<what we are waiting for>" --until <time>   (time: 03:00 | "2026-11-08 03:00" | "in 3h")');
    if (!until) fail('Could not read --until, or it is not within the next 14 days. Use 03:00, "2026-11-08 03:00" or "in 3h".');
    const { waitingFor: _w, ...held } = j;
    put({ ...held, status: 'active', holdFor: what.slice(0, 300), holdUntil: until!, updatedAt: Date.now(), lastNudge: undefined, nudgesToday: 0, stuckDay: undefined });
    saveAsks(asksPath(MANAGER_NOTES_DIR), loadAsks(asksPath(MANAGER_NOTES_DIR)).filter((a) => a.job !== j.id));
    const watch = holdWatch(j.id, j.title, what.slice(0, 300), until!, JOB_CLI);
    saveSchedule(SCHEDULE, [...loadSchedule(SCHEDULE).filter((t) => t.id !== watch.id), watch]);
    console.log(`${j.id} is held until ${new Date(until!).toLocaleString('en-GB')}: waiting for ${what}. No nudges and no button for the owner; it resumes by itself then. The office added a watch for it to the timetable ("${watch.title}", every 2 hours until then; it goes when the job does). To end the hold early: job go ${j.id}`);
    break;
  }
  case 'go': {
    const j = find(rest[0]);
    const { waitingFor: _w, holdFor: _hf, holdUntil: _hu, ...back } = j;
    put({ ...back, status: 'active', updatedAt: Date.now(), lastNudge: undefined, nudgesToday: 0 });
    saveAsks(asksPath(MANAGER_NOTES_DIR), loadAsks(asksPath(MANAGER_NOTES_DIR)).filter((a) => a.job !== j.id));
    dropWatch(j.id);
    console.log(`${j.id} is active again.`);
    break;
  }
  case 'done': {
    const j = find(rest[0]);
    const { waitingFor: _w, holdFor: _hf, holdUntil: _hu, ...fin } = j;
    put({ ...fin, status: 'done', updatedAt: Date.now() });
    saveAsks(asksPath(MANAGER_NOTES_DIR), loadAsks(asksPath(MANAGER_NOTES_DIR)).filter((a) => a.job !== fin.id));
    dropWatch(j.id);
    console.log(`${j.id} is done.`);
    break;
  }
  case 'show': {
    const j = find(rest[0]);
    console.log(describeJobs([j], base));
    const bp = briefPath(MANAGER_NOTES_DIR, j.id);
    try {
      const brief = readFileSync(bp, 'utf8');
      console.log(`\n${brief}`);
      const empty = emptySections(brief);
      if (empty.length) console.log(`\n(Brief still empty: ${empty.join(', ')}. Ask the manager.)`);
    } catch {
      console.log(`\nNo brief yet at ${bp}.`);
    }
    break;
  }
  case 'note': {
    const j = find(rest[0]);
    const text = rest.slice(1).join(' ').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500);
    if (!text) fail('usage: job note <id> "<what happened>"');
    const bp = briefPath(MANAGER_NOTES_DIR, j.id);
    if (!existsSync(bp)) {
      mkdirSync(dirname(bp), { recursive: true, mode: 0o700 });
      writeFileSync(bp, briefTemplate(j), { mode: 0o600 });
    }
    const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    appendFileSync(bp, `- ${stamp}: ${text}\n`);
    console.log(`Noted in ${bp}.`);
    break;
  }
  case 'remove':
    find(rest[0]);
    saveJobs(path, jobs.filter((x) => x.id !== rest[0]));
    dropWatch(rest[0]!);
    console.log(`Removed ${rest[0]}.`);
    break;
  default:
    fail('usage: job list | add ... | show <id> | note <id> "<what>" | wait <id> "<what>" --why <reason> --tried "<what>" | hold <id> "<what>" --until <time> | go <id> | done <id> | remove <id>');
}
