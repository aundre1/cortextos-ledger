// A config-declared provider quota window (`config.providers.<name>.windows`,
// docs/architecture.md "Configuration") must be a real, enforced ceiling on
// its own -- an operator who never runs `quota:set` still gets the limit the
// config file documents. This file drives the real CLI end to end (spawn
// bin/cortexctl.mjs as a child, the way test/cli.test.mjs and
// test/runs.test.mjs do): a config with a `windows` ceiling, no `quota:set`
// call anywhere, real spend recorded through `ingest`, and an assertion that
// the documented exit code (docs/state-machine.md: 4, reason `quota`) and
// escalation row (docs/ledger.md: reason `quota`) actually fire.
//
// Before the fix in src/quota.mjs (`syncConfigQuota`) and its call sites in
// src/limits.mjs (`checkQuota`) and src/ingest.mjs, `checkQuota` only ever
// read `provider_quota` rows, and nothing but `quota:set` ever wrote one --
// so this file's first test failed (run:start exited 0, never refused) on
// the pre-fix tree. See the wave log entry for this task for the exact
// before/after run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';

// Same shape test/runs.test.mjs uses: config, db, and worktree in separate
// temp dirs so the files_touched guard never sees this test's own scratch
// files as if an agent had touched them.
function setup(providers) {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const configPath = join(homeDir, 'cortex-ledger.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      db: './ledger.db',
      runs: './runs',
      limits: {
        builder_attempts_max: 3,
        challenge_cycles_max: 1,
        wallclock_s: 5400,
        spend_usd: 5.0, // well above the provider ceiling below, so the task
        // level budget gate never fires first and masks the quota gate.
        files_touched_max: 10,
        stall_s: 900,
      },
      providers,
    })
  );
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

function startRun(ctx, taskId, extra = []) {
  return cli(
    ['run:start', '--task', taskId, '--agent', 'solo', '--provider', 'configquota-test', '--model', 'm1', ...extra],
    ctx
  );
}

function writeEventsFile(dir, costUsd) {
  const eventsPath = join(dir, 'events.jsonl');
  const events = [
    { type: 'session.start', session_id: 's1' },
    { type: 'message', role: 'assistant', tokens_in: 100, tokens_out: 50, cost_usd: costUsd },
    { type: 'session.end', exit_code: 0, requests: 1 },
  ];
  writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return eventsPath;
}

function taskShowEscalations(ctx, taskId) {
  const result = cli(['task:show', taskId, '--json'], ctx);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).escalations;
}

// ---------------------------------------------------------------------------

test('a config-only provider window (no quota:set ever called) is enforced: run:start refuses at exit 4 with escalation reason quota', () => {
  // limit_usd is 6, not 1: arbitration 2026-09-08 made checkQuota reserve
  // the ADMITTING call's own share pessimistically too, at
  // max(projectedCost, spend_usd) - here spend_usd is 5.0 (see setup()'s
  // comment), so every run:start against a limit_usd window now commits at
  // least $5 against it on its own, before any real spend is ever
  // recorded. A $1 ceiling would refuse the very first run:start on
  // reservation alone and never exercise this test's actual point: that
  // real spend recorded by `ingest` (never `quota:set`/`quota:tick`) is
  // what pushes a config-only ceiling over on a later call.
  const ctx = setup({
    'configquota-test': { windows: [{ kind: 'day', limit_usd: 6 }] },
  });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  // First run: reserves its own $5 share (0 real usage + 0 other running +
  // $5 own share = $5 <= $6). Passes.
  const first = startRun(ctx, taskId);
  assert.equal(first.code, 0, first.stderr);
  const runId = first.stdout.trim();
  assert.match(runId, /^r_/);

  // Record real spend through the real `ingest` command (never `quota:set`,
  // never `quota:tick`) that pushes this provider's usage past the config's
  // own $6/day ceiling once a second call's own $5 reservation is added.
  // ingest's session.end event (exit_code 0) also moves the first run out
  // of 'running', so it no longer contributes to the *other-runs* term.
  const eventsPath = writeEventsFile(ctx.homeDir, 2.5);
  const ingestResult = cli(['ingest', '--events', eventsPath, '--task', taskId, '--run', runId], ctx);
  assert.equal(ingestResult.code, 0, ingestResult.stderr);
  assert.match(ingestResult.stdout, /cost_usd=2\.5/);

  // quota:show must reflect the config-derived ceiling and its origin, not
  // an empty table (which would read as "no limit").
  const show = cli(['quota:show'], ctx);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /configquota-test/);
  assert.match(show.stdout, /origin config/);

  // Second run:start on the same task, same provider: $2.50 real usage + 0
  // other running runs + this call's own $5 reservation = $7.50, over the
  // $6 ceiling, with no quota:set row ever having been written. This is the
  // exact defect this task fixes -- before the fix, checkQuota never looked
  // at config at all and this refusal never fired (exit 0, task allowed to
  // keep spending past its documented ceiling).
  const second = startRun(ctx, taskId);
  assert.equal(second.code, 4, second.stderr);
  assert.match(second.stderr, /^cortexctl: quota: /);

  const escalations = taskShowEscalations(ctx, taskId);
  const quotaEscalations = escalations.filter((e) => e.reason === 'quota');
  assert.equal(quotaEscalations.length, 1, JSON.stringify(escalations));
  assert.equal(quotaEscalations[0].severity, 'halt');
});

test('quota:set overrides the config ceiling for the same window, permanently', () => {
  const ctx = setup({
    'configquota-test': { windows: [{ kind: 'day', limit_usd: 1 }] },
  });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  // Operator override: raise the ceiling for this provider/window above
  // what the config file says (config says $1, operator raises it to $10).
  const setResult = cli(
    ['quota:set', '--provider', 'configquota-test', '--window', 'day', '--limit-usd', '10'],
    ctx
  );
  assert.equal(setResult.code, 0, setResult.stderr);

  const first = startRun(ctx, taskId);
  assert.equal(first.code, 0, first.stderr);
  const runId = first.stdout.trim();

  // Spend $2.50 -- over the config's $1 ceiling, comfortably under the
  // operator's $10 override.
  const eventsPath = writeEventsFile(ctx.homeDir, 2.5);
  const ingestResult = cli(['ingest', '--events', eventsPath, '--task', taskId, '--run', runId], ctx);
  assert.equal(ingestResult.code, 0, ingestResult.stderr);

  // A second run must still be allowed: the manual override, not the
  // config's own lower number, is the ceiling in force.
  const second = startRun(ctx, taskId);
  assert.equal(second.code, 0, second.stderr);

  const show = cli(['quota:show', '--json'], ctx);
  assert.equal(show.code, 0, show.stderr);
  const rows = JSON.parse(show.stdout);
  const row = rows.find((r) => r.provider === 'configquota-test' && r.window_kind === 'day');
  assert.ok(row, JSON.stringify(rows));
  assert.equal(row.limit_usd, 10);
  assert.equal(row.origin, 'quota:set');

  // The config file's own number for this window must never have clobbered
  // the operator's override, even though checkQuota/ingest/quota:show all
  // ran their config-sync step multiple times above.
  assert.notEqual(row.limit_usd, 1);
});

test('quota:show prints the effective ceiling and its origin for both a config-only window and a quota:set window', () => {
  const ctx = setup({
    'configquota-test': { windows: [{ kind: 'day', limit_usd: 1 }] },
    'other-configquota-test': { windows: [{ kind: 'minute', limit_requests: 5 }] },
  });
  assert.equal(cli(['init'], ctx).code, 0);

  assert.equal(
    cli(['quota:set', '--provider', 'other-configquota-test', '--window', 'minute', '--limit-requests', '2'], ctx)
      .code,
    0
  );

  const show = cli(['quota:show', '--json'], ctx);
  assert.equal(show.code, 0, show.stderr);
  const rows = JSON.parse(show.stdout);

  const configRow = rows.find((r) => r.provider === 'configquota-test');
  assert.ok(configRow, JSON.stringify(rows));
  assert.equal(configRow.origin, 'config');
  assert.equal(configRow.limit_usd, 1);
  assert.equal(configRow.source, 'config');

  const manualRow = rows.find((r) => r.provider === 'other-configquota-test');
  assert.ok(manualRow, JSON.stringify(rows));
  assert.equal(manualRow.origin, 'quota:set');
  assert.equal(manualRow.limit_requests, 2); // the operator's override, not config's 5
  assert.equal(manualRow.source, 'manual');

  // Human readable form also carries the origin, not only --json.
  const showHuman = cli(['quota:show'], ctx);
  assert.equal(showHuman.code, 0, showHuman.stderr);
  assert.match(showHuman.stdout, /configquota-test \* day\s+usd 0\.00\/1\.00 \(reserved 0\.00\)\s+resets .*\s+origin config/);
  assert.match(showHuman.stdout, /other-configquota-test \* minute\s+requests 0\/2\s+resets .*\s+origin quota:set/);
});
