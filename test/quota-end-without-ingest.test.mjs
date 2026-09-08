// Codex round, F2 (major): src/quota.mjs's `reservedSpend` only counted
// `task_runs` rows with `status = 'running'`. `run:end` accepts a `--cost`
// flag and writes it straight to `task_runs.cost_usd` (src/commands/runs.mjs
// doRunEnd), but never touches `cost_usage` or `provider_quota` - only
// `ingest` does that (src/ingest.mjs). So a caller who calls `run:start`
// then `run:end` WITHOUT a following `ingest` had that run's spend counted
// nowhere: the instant its status left 'running', `reservedSpend` stopped
// seeing it (no more reservation), and no `cost_usage` row was ever written
// (no real usage either). Reproduced here with the exact numbers from the
// review: a `limit_usd: 5` provider window, a `spend_usd: 4` per-task cap,
// one run:start + run:end --cost 4 with no ingest - a second run:start
// should still be refused (that first run's $4 is still unaccounted for),
// but before the fix it was admitted clean.
//
// Fixed by dropping the `status = 'running'` filter in `reservedSpend`
// entirely: any task_runs row for this provider with no cost_usage row yet
// reserves its full per-run budget, whatever its status - the reservation
// only clears once `ingest` actually records the run's real cost. Fail
// closed: skipping ingest keeps consuming quota headroom rather than the
// spend silently vanishing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function writeConfig(homeDir) {
  const configPath = join(homeDir, 'cortex-ledger.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      db: './ledger.db',
      runs: './runs',
      limits: {
        builder_attempts_max: 20,
        challenge_cycles_max: 1,
        wallclock_s: 5400,
        spend_usd: 4, // the per-task budget cap reservedSpend's `perRun` reads
        files_touched_max: 10,
        stall_s: 900,
      },
      providers: {
        racer: { windows: [{ kind: 'day', limit_usd: 5 }] },
      },
    })
  );
  return configPath;
}

function setup() {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const configPath = writeConfig(homeDir);
  return { homeDir, dir, baseCommit, configPath, env: { ...process.env } };
}

function cli(args, ctx) {
  return runCli(['--config', ctx.configPath, ...args], { env: ctx.env });
}

function newTask(ctx) {
  const result = cli(
    ['task:new', '--repo', 'o/n', '--title', 't', '--class', 'ci', '--arm', 'control',
     '--worktree', ctx.dir, '--base', ctx.baseCommit],
    ctx
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('F2: run:end without a following ingest still reserves that run\'s spend, so a second run against the same window is correctly refused', async () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const task1 = newTask(ctx);
  const task2 = newTask(ctx);

  const start1 = cli(['run:start', '--task', task1, '--agent', 'solo', '--provider', 'racer', '--model', 'm1'], ctx);
  assert.equal(start1.code, 0, start1.stderr);
  const run1 = start1.stdout.trim();

  // End the run reporting real spend of $4 - but never call `ingest`.
  const end1 = cli(['run:end', '--run', run1, '--exit', '0', '--cost', '4'], ctx);
  assert.equal(end1.code, 0, end1.stderr);

  const show = cli(['quota:show', '--json'], ctx);
  assert.equal(show.code, 0, show.stderr);
  const rows = JSON.parse(show.stdout);
  const row = rows.find((r) => r.provider === 'racer' && r.window_kind === 'day');
  assert.ok(row, 'expected a racer/day provider_quota row');
  assert.equal(row.used_usd, 0, 'used_usd should still be 0 - ingest never ran to tick it');
  assert.equal(
    row.reserved_usd,
    4,
    `reserved_usd should still hold the $4 from run ${run1} even though it already ended without ingest`
  );

  // A second run against the same window: reserved (4) + this call's own
  // share (max(projectedCost=0, spend_usd=4) = 4) = 8 > limit_usd 5 -> must
  // be refused. Before the fix, run1's reservation vanished the moment its
  // status left 'running' in run:end, so this admitted cleanly (0 + 4 = 4 <= 5).
  const start2 = cli(['run:start', '--task', task2, '--agent', 'solo', '--provider', 'racer', '--model', 'm1'], ctx);
  assert.equal(start2.code, 4, start2.stderr || start2.stdout);
  assert.match(start2.stderr, /quota/i, `expected a quota refusal, got: ${start2.stderr}`);

  const escalations = JSON.parse(cli(['task:show', task2, '--json'], ctx).stdout).escalations;
  assert.ok(
    escalations.some((e) => e.reason === 'quota'),
    'task2 should carry a quota escalation'
  );
});
