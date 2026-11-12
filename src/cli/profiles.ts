// Which Chrome profile holds which sign-in (src/team/profiles.ts). Check before any web console.
//   profiles                      the whole list
//   profiles <site>               the line for one site (exit 1 if none)
//   profiles set "<site>" "<profile>" --how "<how a room reaches it>" [--by "<your name>"]

import { DATA_DIR } from '../paths.ts';
import { loadProfiles, profileFor, profilesPath, renderProfiles, setProfile } from '../team/profiles.ts';

const path = profilesPath(DATA_DIR);
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};

if (args[0] === 'set') {
  const how = flag('--how') ?? '';
  const by = flag('--by') ?? process.env.CM_DESK_FROM ?? 'a room';
  const [, site, profile] = args;
  if (!site || !profile) {
    console.error('usage: profiles set "<site>" "<profile>" --how "<how a room reaches it>" [--by "<your name>"]');
    process.exit(1);
  }
  try {
    const l = setProfile(path, { site, profile, how, by });
    console.log(`Noted: ${l.site} -> ${l.profile}. Every room checks this before using ${l.site}.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
} else if (args[0]) {
  const l = profileFor(loadProfiles(path), args[0]);
  if (!l) {
    console.log(`No profile noted for ${args[0]}. Try the connected browser; if you find the right profile, note it with: profiles set "${args[0]}" "<profile>" --how "<how>".`);
    process.exit(1);
  }
  console.log(renderProfiles([l]));
} else console.log(renderProfiles(loadProfiles(path)));
