// Fixes for four defects a blind reviewer confirmed by reproduction against
// the cortextos-ledger v0.1 tree at 6c46257 (see the wave log for the full
// repro write-ups). NF2 (withImmediateTransaction's reentrant rollback gap)
// is a db.mjs primitive with no CLI surface, and its test lives in
// test/db.test.mjs next to withImmediateTransaction's other tests instead.
// The three fixes here all have a CLI-visible effect, so each test drives
// the real spawned `cortexctl` (test/helpers.mjs's runCli), the same style
// test/quota-admission.test.mjs and test/pr-capture.test.mjs already use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';
import { openDb } from '../src/db.mjs';
import { sweepTmpDir, pidSidecarPath } from '../src/tmp-sweep.mjs';

function writeConfig(homeDir, { name = 'cortex-ledger.json', limits = {}, providers = {} } = {}) {
  const configPath = join(homeDir, name);
  writeFileSync(
    configPath,
    JSON.stringify({
      db: './ledger.db',
      runs: './runs',
      limits: {
        builder_attempts_max: 20,
        challenge_cycles_max: 1,
        wallclock_s: 5400,
        spend_usd: 5.0,
        files_touched_max: 10,
        stall_s: 900,
        ...limits,
      },
      providers,
    })
  );
  return configPath;
}

function setup(providers = {}, limitsOverride = {}) {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const configPath = writeConfig(homeDir, { providers, limits: limitsOverride });
  return { homeDir, dir, baseCommit, configPath, env: { ...process.env } };
}

function cli(args, ctx) {
  return runCli(['--config', ctx.configPath, ...args], { env: ctx.env });
}

function newTask(ctx, extra = []) {
  const result = cli(
    ['task:new', '--repo', 'o/n', '--title', 't', '--class', 'ci', '--arm', 'control',
     '--worktree', ctx.dir, '--base', ctx.baseCommit, ...extra],
    ctx
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function dbPath(ctx) {
  return join(ctx.homeDir, 'ledger.db');
}

function runRow(ctx, runId) {
  const db = openDb(dbPath(ctx));
  const row = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId);
  db.close();
  return row;
}

// ---------------------------------------------------------------------------
// NF1 (high): reservedSpend counted a `running` run's phantom `spend_usd`
// reservation forever, even after that run's real cost had been ingested
// into cost_usage - because ingest never has any reason to flip
// task_runs.status away from 'running' on its own (only run:end, or a
// watchdog, ever does that), and run:start is a documented standalone
// command with no guaranteed watchdog behind it. Repro: ingest $9 for a run
// left running, limit_usd 12, spend_usd 3 -> quota:show shows used 9 +
// reserved 3 = 12; a fresh run:start is refused (9 + 3 reserved + 3 own
// share = 15 > 12); a simulated day rollover zeroes used_usd but the
// reservation survives it. Fixed in src/quota.mjs `reservedSpend`: a
// `running` run stops counting as a reservation the instant a `cost_usage`
// row exists for its `run_id`.
// ---------------------------------------------------------------------------

test('NF1: a running run whose cost has been ingested stops holding a phantom spend reservation', () => {
  const ctx = setup({ 'nf1-prov': { windows: [{ kind: 'day', limit_usd: 12 }] } }, { spend_usd: 3 });
  assert.equal(cli(['init'], ctx).code, 0);

  const taskA = newTask(ctx);
  const startA = cli(['run:start', '--task', taskA, '--agent', 'solo', '--provider', 'nf1-prov', '--model', 'm1'], ctx);
  assert.equal(startA.code, 0, startA.stderr);
  const runA = startA.stdout.trim();

  // Simulate the harness emitting its final cost event and then crashing
  // before ever writing exit.txt or a session.end event - no `run:end` runs,
  // so `task_runs.status` never leaves 'running'. This is exactly NF1's
  // premise: a run whose real cost is known but whose status still says
  // "running" forever.
  const outDir = runRow(ctx, runA).out_dir;
  mkdirSync(outDir, { recursive: true });
  const eventsPath = join(outDir, 'events.jsonl');
  writeFileSync(
    eventsPath,
    JSON.stringify({ type: 'message', role: 'assistant', cost_usd: 9, tokens_in: 100, tokens_out: 50 }) + '\n'
  );
  const ingestResult = cli(['ingest', '--events', eventsPath, '--task', taskA, '--run', runA, '--json'], ctx);
  assert.equal(ingestResult.code, 0, ingestResult.stderr);

  const after = runRow(ctx, runA);
  assert.equal(after.status, 'running', 'sanity: the run must genuinely still be running, matching the repro');
  assert.equal(after.cost_usd, 9);

  const show = JSON.parse(cli(['quota:show', '--json'], ctx).stdout);
  const row = show.find((r) => r.provider === 'nf1-prov');
  assert.ok(row, JSON.stringify(show));
  assert.equal(row.used_usd, 9, 'real ingested cost is recorded');
  assert.equal(
    row.reserved_usd,
    0,
    'NF1: once the run\'s real cost is known via ingest, its reservation must clear even though status is still "running"'
  );

  // A brand new run on the same provider: real usage (9) + this call's own
  // worst-case share (spend_usd 3) = 12, exactly at the ceiling - it must be
  // admitted, not refused by a phantom reservation stacked on top of the
  // real usage that already accounts for runA.
  const taskB = newTask(ctx);
  const startB = cli(['run:start', '--task', taskB, '--agent', 'solo', '--provider', 'nf1-prov', '--model', 'm1'], ctx);
  assert.equal(
    startB.code,
    0,
    `expected the second run to be admitted (9 used + 0 reserved + 3 own share = 12 <= 12), got: ${JSON.stringify(startB)}`
  );
});

test('NF1: the cleared reservation survives a window rollover too (used_usd resets to zero, reserved_usd stays zero, not resurrected)', () => {
  const ctx = setup({ 'nf1-roll': { windows: [{ kind: 'day', limit_usd: 12 }] } }, { spend_usd: 3 });
  assert.equal(cli(['init'], ctx).code, 0);

  const taskA = newTask(ctx);
  const startA = cli(['run:start', '--task', taskA, '--agent', 'solo', '--provider', 'nf1-roll', '--model', 'm1'], ctx);
  assert.equal(startA.code, 0, startA.stderr);
  const runA = startA.stdout.trim();

  const outDir = runRow(ctx, runA).out_dir;
  mkdirSync(outDir, { recursive: true });
  const eventsPath = join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, JSON.stringify({ type: 'message', role: 'assistant', cost_usd: 9 }) + '\n');
  assert.equal(cli(['ingest', '--events', eventsPath, '--task', taskA, '--run', runA, '--json'], ctx).code, 0);

  // Simulate a day rollover by backdating the window's start far into the
  // past; quota:show rolls windows forward before listing them.
  const db = openDb(dbPath(ctx));
  db.prepare(
    "UPDATE provider_quota SET window_started_at = '2000-01-01T00:00:00.000Z' WHERE provider = 'nf1-roll'"
  ).run();
  db.close();

  const afterRollover = JSON.parse(cli(['quota:show', '--json'], ctx).stdout).find((r) => r.provider === 'nf1-roll');
  assert.ok(afterRollover, 'window should still exist after rolling');
  assert.equal(afterRollover.used_usd, 0, 'the window should have rolled, resetting used_usd to zero');
  assert.equal(
    afterRollover.reserved_usd,
    0,
    'the reservation must stay cleared across a rollover - a status still stuck on "running" must not resurrect it'
  );
});

// ---------------------------------------------------------------------------
// NF3 (medium): a raw, unredacted PR diff streamed into
// <runs>/.tmp/<taskId>.pr.diff.raw during task:new's PR capture survives on
// disk forever if cortexctl itself is killed mid-capture - nothing ever
// swept `.tmp/`. Fixed by sweeping `.tmp/` (entries older than 60 minutes)
// at the start of `init` and at the start of every `task:new`.
// ---------------------------------------------------------------------------

test('NF3: task:new sweeps stale <runs>/.tmp/ entries (older than 60 minutes) but leaves fresh ones alone', () => {
  const ctx = setup({});
  assert.equal(cli(['init'], ctx).code, 0);

  const tmpDir = join(ctx.homeDir, 'runs', '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const stalePath = join(tmpDir, 'stale-leftover.pr.diff.raw');
  const freshPath = join(tmpDir, 'fresh-leftover.pr.diff.raw');
  writeFileSync(stalePath, 'unredacted diff content that must not survive a sweep\n');
  writeFileSync(freshPath, 'a just-created leftover, e.g. from a concurrent capture in flight\n');

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

  // Any task:new call sweeps .tmp/ at its start, regardless of --kind - this
  // is a plain implement task, not a pr_review capture.
  const taskId = newTask(ctx);
  assert.ok(taskId);

  assert.ok(!existsSync(stalePath), 'a .tmp entry older than 60 minutes must be swept by task:new');
  assert.ok(existsSync(freshPath), 'a fresh .tmp entry must survive the sweep');
});

test('NF3: init also sweeps stale <runs>/.tmp/ entries', () => {
  const ctx = setup({});

  const tmpDir = join(ctx.homeDir, 'runs', '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  const stalePath = join(tmpDir, 'stale-from-a-killed-process.pr.diff.raw');
  writeFileSync(stalePath, 'unredacted diff content\n');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

  assert.equal(cli(['init'], ctx).code, 0);
  assert.ok(!existsSync(stalePath), 'init must sweep a stale .tmp entry too, not only task:new');
});

// ---------------------------------------------------------------------------
// NF4 (low-medium): doRunStart set task_runs.quota_reserved = 1
// unconditionally, even when reserveRequest matched zero provider_quota
// rows (no window declared for this provider/model yet). If a window is
// declared later and that run's events are then ingested, ingest sees
// quota_reserved = 1 and assumes a request was already counted for it,
// permanently dropping the run's real request count from the new window.
// Fixed: quota_reserved is only set to 1 when reserveRequest actually
// reserved something.
// ---------------------------------------------------------------------------

test('NF4: run:start with no window leaves quota_reserved unset; a window added later still counts that run\'s real requests at ingest', () => {
  const ctx = setup({}); // no providers declared at all at run:start time
  assert.equal(cli(['init'], ctx).code, 0);

  const taskA = newTask(ctx);
  const start = cli(['run:start', '--task', taskA, '--agent', 'solo', '--provider', 'nf4-prov', '--model', 'm1'], ctx);
  assert.equal(start.code, 0, start.stderr);
  const runA = start.stdout.trim();

  const before = runRow(ctx, runA);
  assert.equal(before.quota_reserved, 0, 'NF4: no window matched, so nothing was reserved - quota_reserved must stay 0');

  // A window for this provider is declared only now, after the run started.
  const configWithWindow = writeConfig(ctx.homeDir, {
    name: 'with-window.json',
    providers: { 'nf4-prov': { windows: [{ kind: 'day', limit_requests: 100 }] } },
  });
  const ctxWithWindow = { ...ctx, configPath: configWithWindow };

  const outDir = before.out_dir;
  mkdirSync(outDir, { recursive: true });
  const eventsPath = join(outDir, 'events.jsonl');
  // Three message events -> requests = messageCount = 3 (docs/ingest.mjs:
  // "requests (count of message events, or session.end requests if present)").
  const lines = [
    { type: 'message', role: 'assistant', tokens_in: 10, tokens_out: 5 },
    { type: 'message', role: 'assistant', tokens_in: 10, tokens_out: 5 },
    { type: 'message', role: 'assistant', tokens_in: 10, tokens_out: 5 },
  ];
  writeFileSync(eventsPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const ingestResult = cli(['ingest', '--events', eventsPath, '--task', taskA, '--run', runA, '--json'], ctxWithWindow);
  assert.equal(ingestResult.code, 0, ingestResult.stderr);
  assert.equal(JSON.parse(ingestResult.stdout).requests, 3);

  const show = JSON.parse(cli(['quota:show', '--json'], ctxWithWindow).stdout);
  const row = show.find((r) => r.provider === 'nf4-prov');
  assert.ok(row, JSON.stringify(show));
  assert.equal(
    row.used_requests,
    3,
    'NF4: the run\'s real request count must be ticked into the new window, not dropped as "already reserved"'
  );
});

test('NF4: run:start that DOES reserve against an existing window still sets quota_reserved, and ingest does not double count it', () => {
  const ctx = setup({ 'nf4-prov2': { windows: [{ kind: 'day', limit_requests: 100 }] } });
  assert.equal(cli(['init'], ctx).code, 0);

  const taskA = newTask(ctx);
  const start = cli(['run:start', '--task', taskA, '--agent', 'solo', '--provider', 'nf4-prov2', '--model', 'm1'], ctx);
  assert.equal(start.code, 0, start.stderr);
  const runA = start.stdout.trim();

  const before = runRow(ctx, runA);
  assert.equal(before.quota_reserved, 1, 'a matching window existed, so the reservation must still be marked');

  const outDir = before.out_dir;
  mkdirSync(outDir, { recursive: true });
  const eventsPath = join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, JSON.stringify({ type: 'message', role: 'assistant' }) + '\n');
  assert.equal(cli(['ingest', '--events', eventsPath, '--task', taskA, '--run', runA, '--json'], ctx).code, 0);

  const row = JSON.parse(cli(['quota:show', '--json'], ctx).stdout).find((r) => r.provider === 'nf4-prov2');
  assert.equal(row.used_requests, 1, 'the one request reserved at run:start must not be double counted by ingest');
});

// ---------------------------------------------------------------------------
// NF5 (minor, round 5): NF3's sweep decided purely on mtime age, so a
// capture genuinely still running past the 60 minute threshold (a very
// large diff, or any process whose wall clock jumps forward) looked
// identical to an abandoned one to a *concurrent* init/task:new's sweep,
// which could then unlink a file the first process was still writing.
// Fixed with a pid sidecar (<name>.pid, containing the writing process's
// pid) that the sweep consults before deciding an mtime-stale entry is
// really abandoned. Unit-level against sweepTmpDir directly (src/tmp-
// sweep.mjs) - the CLI-level task:new tests above already cover the
// ordinary sweep-on-command-start behaviour; this exercises the sidecar
// decision itself precisely, including a deliberately unrealistic (never
// running) pid for the "dead" case.
// ---------------------------------------------------------------------------

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
// Comfortably above any real OS's max pid (Linux's default ceiling is far
// below this) and never reused within a test run - process.kill(pid, 0)
// reliably reports ESRCH for it, without this test depending on the timing
// of any real process actually exiting.
const DEFINITELY_DEAD_PID = 999999999;

test('NF5: an entry with a live-pid sidecar survives the sweep even when its mtime is 2 hours old', () => {
  const runsDir = makeTempDir();
  const tmpDir = join(runsDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  const rawPath = join(tmpDir, 'live.pr.diff.raw');
  writeFileSync(rawPath, 'still being written by a genuinely running process\n');
  writeFileSync(pidSidecarPath(rawPath), String(process.pid)); // this test process is certainly alive

  const twoHoursAgo = new Date(Date.now() - TWO_HOURS_MS);
  utimesSync(rawPath, twoHoursAgo, twoHoursAgo);

  const deleted = sweepTmpDir(runsDir);

  assert.deepEqual(deleted, [], `nothing should be deleted while the sidecar names a live pid: ${JSON.stringify(deleted)}`);
  assert.ok(existsSync(rawPath), 'the raw file must survive - its sidecar names a live pid');
  assert.ok(existsSync(pidSidecarPath(rawPath)), 'the sidecar itself must survive alongside it');
});

test('NF5: an entry with a dead-pid sidecar is removed with its sidecar once stale', () => {
  const runsDir = makeTempDir();
  const tmpDir = join(runsDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  const rawPath = join(tmpDir, 'dead.pr.diff.raw');
  writeFileSync(rawPath, 'abandoned by a process that has since exited\n');
  writeFileSync(pidSidecarPath(rawPath), String(DEFINITELY_DEAD_PID));

  const twoHoursAgo = new Date(Date.now() - TWO_HOURS_MS);
  utimesSync(rawPath, twoHoursAgo, twoHoursAgo);

  const deleted = sweepTmpDir(runsDir);

  assert.ok(deleted.includes('dead.pr.diff.raw'), `expected the raw file to be swept: ${JSON.stringify(deleted)}`);
  assert.ok(deleted.includes('dead.pr.diff.raw.pid'), `expected the sidecar to be swept with it: ${JSON.stringify(deleted)}`);
  assert.ok(!existsSync(rawPath), 'the raw file must be gone');
  assert.ok(!existsSync(pidSidecarPath(rawPath)), 'the sidecar must be gone too');
});

test('NF5: an entry with a future mtime survives the sweep regardless of its sidecar', () => {
  const runsDir = makeTempDir();
  const tmpDir = join(runsDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  const rawPath = join(tmpDir, 'future.pr.diff.raw');
  writeFileSync(rawPath, 'mtime jumped forward, e.g. a corrected system clock\n');
  writeFileSync(pidSidecarPath(rawPath), String(DEFINITELY_DEAD_PID)); // dead pid - only the future mtime should save it

  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
  utimesSync(rawPath, oneHourFromNow, oneHourFromNow);

  const deleted = sweepTmpDir(runsDir);

  assert.deepEqual(deleted, [], `a future mtime can never be proven stale: ${JSON.stringify(deleted)}`);
  assert.ok(existsSync(rawPath), 'the raw file must survive a future mtime');
  assert.ok(existsSync(pidSidecarPath(rawPath)), 'its sidecar must survive alongside it');
});

test('NF5: an entry with no sidecar at all still follows the plain mtime rule (regression, pre-NF5 behaviour preserved)', () => {
  const runsDir = makeTempDir();
  const tmpDir = join(runsDir, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  const stalePath = join(tmpDir, 'no-sidecar-stale.raw');
  const freshPath = join(tmpDir, 'no-sidecar-fresh.raw');
  writeFileSync(stalePath, 'x');
  writeFileSync(freshPath, 'y');
  const twoHoursAgo = new Date(Date.now() - TWO_HOURS_MS);
  utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

  const deleted = sweepTmpDir(runsDir);

  assert.ok(deleted.includes('no-sidecar-stale.raw'));
  assert.ok(!existsSync(stalePath));
  assert.ok(existsSync(freshPath));
});
