// Review round 2, R2-1: doRunStart never persisted the harness pid to
// task_runs.pid (only <outDir>/pid.txt got it, written by runner.mjs), so
// src/guards/watchdog.mjs's tick() calling killTree(run.pid) was a no-op on
// every real launch - a stall or wall clock breach updated the ledger row
// while the process kept running. This test exercises the real, non `--sync`
// run:launch path (docs/adapters.md "spawn helper and credential boundary")
// with a stub 'claude' adapter command that never emits stream events and
// never exits, then proves both halves of the fix against a real OS process:
//
//   1. run:launch itself polls <outDir>/pid.txt after launchDetached and
//      persists it to task_runs.pid (src/adapters/spawn.mjs pollPidFile,
//      wired into src/commands/runs.mjs run:launch).
//   2. src/guards/watchdog.mjs's tick() actually kills that pid - via
//      run.pid directly, or by falling back to reading pid.txt itself when
//      run.pid is null (src/guards/watchdog.mjs resolvePid) - on both a
//      stall and a wall clock breach, and the OS process is verifiably dead
//      afterwards (process.kill(pid, 0) throws ESRCH).
//
// Every run here is launched under generous limits (stall_s 900, wallclock_s
// 5400) so `run:launch`'s own background `cortexctl watch` subprocess -
// spawned on real wall-clock time - never fires during a test: only the
// fake, far-future `now` each test hands directly to `tick()` trips a
// breach. This decouples the assertions from a race against that background
// process while still exercising the exact same tick()/killTree() code it
// runs.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';
import { openDb } from '../src/db.mjs';
import { tick } from '../src/guards/watchdog.mjs';

const GENEROUS_LIMITS = { stallS: 900, wallclockS: 5400 };

// Every OS pid launched by a test in this file, so afterEach can clean up
// anything a failed assertion left running instead of leaking a hung
// `node -e "setInterval(...)"` process past the test run.
const launchedPids = [];

afterEach(() => {
  while (launchedPids.length) {
    const pid = launchedPids.pop();
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

/** true once process.kill(pid, 0) throws (ESRCH) - polled, no fixed sleep. */
async function waitForProcessDeath(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Writes a config with a stub 'claude' adapter (cmd = this node binary,
 * argsPrefix = ['-e', 'setInterval(()=>{},1000)', '--']) that hangs forever:
 * the trailing '--' stops node's own flag parsing right after the eval
 * script, so the rest of claude.mjs's buildArgv() args (-p <prompt>
 * --output-format ... --model ...) land as plain, ignored script arguments
 * instead of node reading e.g. `--output-format` as an unrecognized node
 * flag and exiting immediately (`node: bad option`). It never prints a
 * line, so events.jsonl (created empty at launch) never gets a fresh mtime,
 * and it never exits on its own, so only a real kill ends it.
 */
function makeConfig(dir, { stallS, wallclockS }) {
  const configPath = join(dir, 'cortex-ledger.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      db: './ledger.db',
      runs: './runs',
      limits: {
        builder_attempts_max: 3,
        challenge_cycles_max: 1,
        wallclock_s: wallclockS,
        spend_usd: 5.0,
        files_touched_max: 10,
        stall_s: stallS,
      },
      adapters: {
        claude: { cmd: process.execPath, argsPrefix: ['-e', 'setInterval(()=>{},1000)', '--'] },
      },
    })
  );
  return configPath;
}

/**
 * Launches one real, detached, hung 'claude' run through `run:launch` (under
 * generous limits - see GENEROUS_LIMITS above) and returns everything a
 * test needs: the open db handle, the run row (as task_runs.pid stood right
 * after launch), outDir, and the harness's real OS pid read straight from
 * pid.txt.
 */
async function launchHungRun() {
  const homeDir = makeTempDir();
  const { dir: worktree, baseCommit } = makeTempGitRepo();
  const configPath = makeConfig(homeDir, GENEROUS_LIMITS);
  const cli = (args) => runCli(['--config', configPath, ...args]);

  assert.equal(cli(['init']).code, 0);
  const newTask = cli([
    'task:new', '--repo', 'o/n', '--title', 'watchdog kill', '--class', 'ci', '--arm', 'control',
    '--worktree', worktree, '--base', baseCommit,
  ]);
  assert.equal(newTask.code, 0, newTask.stderr);
  const taskId = newTask.stdout.trim();

  const promptPath = join(homeDir, 'prompt.txt');
  writeFileSync(promptPath, 'hang forever');

  const launch = cli([
    'run:launch', '--task', taskId, '--agent', 'builder', '--adapter', 'claude',
    '--provider', 'claude', '--model', 'claude-stub', '--prompt-file', promptPath,
  ]);
  assert.equal(launch.code, 0, launch.stderr);
  const runId = launch.stdout.trim();

  const dbPath = join(homeDir, 'ledger.db');
  const db = openDb(dbPath);
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId);
  assert.ok(run, 'run row should exist');

  const outDir = run.out_dir;
  const pidPath = join(outDir, 'pid.txt');
  assert.ok(existsSync(pidPath), 'runner.mjs should have written pid.txt');
  const osPid = Number(readFileSync(pidPath, 'utf8').trim());
  assert.ok(Number.isInteger(osPid) && osPid > 0, `pid.txt should hold a real pid, got ${readFileSync(pidPath, 'utf8')}`);
  launchedPids.push(osPid);

  return { db, run, runId, outDir, pidPath, osPid };
}

test('run:launch persists the real harness pid to task_runs.pid (fix layer 1)', async () => {
  const { run, osPid } = await launchHungRun();
  assert.equal(run.pid, osPid, 'task_runs.pid should already equal pid.txt right after run:launch, no watchdog tick needed');
  // The harness is still alive at this point - nothing has killed it yet.
  assert.doesNotThrow(() => process.kill(osPid, 0));
});

test('watchdog tick(): stall breach kills the real process and persists task_runs.pid', async () => {
  const { db, run, osPid } = await launchHungRun();
  assert.equal(run.pid, osPid);

  // Only this fake, far-future `now` (advanced past stall_s: 1) can trip the
  // stall branch - the run was actually launched under GENEROUS_LIMITS, so
  // real wall-clock time is nowhere near either limit.
  const CONFIG = { limits: { stall_s: 1, wallclock_s: 5400 } };
  const fakeNow = new Date(Date.now() + 5000);
  const result = tick(db, CONFIG, run, fakeNow);
  assert.equal(result, 'stall');

  const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(updated.status, 'stalled');
  assert.equal(updated.halted_reason, 'stall');
  assert.equal(updated.pid, osPid, 'task_runs.pid should still equal the real pid after the tick');

  const died = await waitForProcessDeath(osPid);
  assert.ok(died, `expected pid ${osPid} to be dead after a stall-triggered killTree`);
});

test('watchdog tick(): falls back to pid.txt when task_runs.pid is null, and still kills', async () => {
  const { db, run, outDir, osPid } = await launchHungRun();

  // Simulate a row that predates run:launch's own pid-persisting poll (or a
  // crash between launch and that poll completing): task_runs.pid is null,
  // but pid.txt is still on disk.
  db.prepare('UPDATE task_runs SET pid = NULL WHERE id = ?').run(run.id);
  const nulledRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(nulledRun.pid, null);
  assert.ok(existsSync(join(outDir, 'pid.txt')));

  const CONFIG = { limits: { stall_s: 1, wallclock_s: 5400 } };
  const fakeNow = new Date(Date.now() + 5000);
  const result = tick(db, CONFIG, nulledRun, fakeNow);
  assert.equal(result, 'stall');

  const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(updated.status, 'stalled');
  assert.equal(updated.halted_reason, 'stall', 'a pid recovered via the pid.txt fallback should not get the pid_unknown suffix');
  assert.equal(updated.pid, osPid, 'the fallback-resolved pid should be persisted back onto task_runs.pid');

  const died = await waitForProcessDeath(osPid);
  assert.ok(died, `expected pid ${osPid} to be dead after the pid.txt fallback kill`);
});

test('watchdog tick(): wall clock breach kills the real process and persists task_runs.pid', async () => {
  const { db, run, osPid } = await launchHungRun();
  assert.equal(run.pid, osPid);

  // Simulate the wall clock limit this run started under (stamped from
  // config.limits.wallclock_s onto task_runs.wallclock_limit_s at
  // insertRun time - see doRunStart) having been a tight 60s, without
  // needing the background watcher's own launch config to race a real 60s
  // window during the test.
  db.prepare('UPDATE task_runs SET wallclock_limit_s = 60 WHERE id = ?').run(run.id);
  const tightRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);

  const CONFIG = { limits: { stall_s: 900, wallclock_s: 60 } };
  const fakeNow = new Date(Date.parse(tightRun.started_at) + 65000);
  const result = tick(db, CONFIG, tightRun, fakeNow);
  assert.equal(result, 'wallclock');

  const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(updated.status, 'halted');
  assert.equal(updated.halted_reason, 'wallclock');
  assert.equal(updated.pid, osPid);

  const died = await waitForProcessDeath(osPid);
  assert.ok(died, `expected pid ${osPid} to be dead after a wallclock-triggered killTree`);
});
