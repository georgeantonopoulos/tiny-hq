import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHogs, HOG_WINDOW_MS, isSystem, nameOf, parsePs, seconds, SIM_MAX_MS, simsToStop, type Sample } from '../src/team/runaway.ts';

const SIM = '/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.2.simruntime/Contents/Resources/RuntimeRoot/System/Library/ExtensionKit/Extensions/WebContentExtension.appex/com.apple.WebKit.WebContent';

test('ps times parse', () => {
  assert.equal(seconds('885:31.32'), 885 * 60 + 31.32);
  assert.equal(seconds('07-05:44:48'), 7 * 86_400 + 5 * 3600 + 44 * 60 + 48);
  assert.equal(seconds('00:26'), 26);
  const p = parsePs(`  644 885:31.32 07-05:44:48 /System/Library/WindowServer -daemon\n56383 5000:00.00 04-03:06:41 ${SIM}\n`);
  assert.equal(p.length, 2);
  assert.equal(p[1]!.command, SIM);
});

test('a simulator left booted is shut down after 3 hours, unless the owner is using it', () => {
  const sims: Record<string, number> = {};
  assert.deepEqual(simsToStop(['a'], sims, false, 0), [], 'first seen now');
  assert.deepEqual(simsToStop(['a', 'b'], sims, false, SIM_MAX_MS - 1), []);
  assert.deepEqual(simsToStop(['a', 'b'], sims, false, SIM_MAX_MS), ['a']);
  simsToStop(['b'], sims, false, SIM_MAX_MS + 1);
  assert.deepEqual(Object.keys(sims), ['b'], 'a shut-down simulator is forgotten, so a new boot gets a fresh 3 hours');
  // The owner at Simulator or Xcode restarts the clock, so 5 minutes after they look away it isn't cut off.
  assert.deepEqual(simsToStop(['b'], sims, true, 10 * SIM_MAX_MS), [], 'the owner at the Simulator');
  assert.deepEqual(simsToStop(['b'], sims, false, 10 * SIM_MAX_MS + 5 * 60_000), []);
  assert.deepEqual(simsToStop(['b'], sims, false, 11 * SIM_MAX_MS), ['b']);
});

test('a program burning most of a core for an hour is reported once; the OS and simulators are not', () => {
  const samples = new Map<number, Sample[]>();
  const told = new Set<number>();
  const at = (min: number, hogCpu: number) => [
    { pid: 1, cpuSec: hogCpu, ageSec: 99_999, command: '/Applications/Foo.app/Contents/MacOS/Foo' },
    { pid: 2, cpuSec: hogCpu, ageSec: 99_999, command: '/System/Library/WindowServer' },
    { pid: 3, cpuSec: hogCpu, ageSec: 99_999, command: SIM },
    { pid: 4, cpuSec: min * 6, ageSec: 99_999, command: '/opt/homebrew/bin/node' }, // 10% of a core
  ];
  let hogs: ReturnType<typeof findHogs> = [];
  for (let min = 0; min <= 60; min += 5) hogs = findHogs(at(min, min * 60 * 0.95), samples, told, min * 60_000);
  assert.deepEqual(hogs.map((h) => h.proc.pid), [1]);
  assert.ok(hogs[0]!.share > 0.9);
  assert.equal(nameOf(hogs[0]!.proc.command), 'Foo');
  told.add(1);
  assert.deepEqual(findHogs(at(65, 65 * 60 * 0.95), samples, told, 65 * 60_000), [], 'told once');
  assert.ok(samples.get(1)!.length <= 14, 'samples stay small');
  // A short burst (a 5-minute build on four cores) is never a hog.
  const s2 = new Map<number, Sample[]>();
  for (let min = 0; min <= 60; min += 5) hogs = findHogs([{ pid: 9, cpuSec: Math.min(min, 5) * 60 * 4, ageSec: 1, command: '/x/rustc' }], s2, new Set(), min * 60_000);
  assert.deepEqual(hogs, []);
  assert.ok(HOG_WINDOW_MS >= 60 * 60_000);
});

test('names read as the owner would say them', () => {
  assert.equal(nameOf('/Applications/Google Chrome.app/Contents/Frameworks/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/x --type=renderer'), 'Google Chrome (Google Chrome Helper (Renderer))');
  assert.equal(nameOf('/Users/sam/.cargo/bin/cargo check'), 'cargo');
  assert.ok(isSystem('/usr/libexec/foo') && isSystem('(kernel_task)') && isSystem('/System/Library/WindowServer'));
  // What rooms start counts, bare names included.
  for (const c of ['node server.js', 'npm run dev', 'claude', 'python3 x.py', '/usr/bin/python3 x.py', '/usr/local/bin/node', '/Applications/Foo.app/x'])
    assert.ok(!isSystem(c), c);
});
