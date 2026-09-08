// Round 3 review fixes: F1 (provider quota admission gate), F3 (provider_quota
// duplicate-row race), F7 (clearing a stale provider_quota row).
//
// F1 (blocker): a config-declared `providers.<x>.windows` ceiling was read at
// `run:start`/`preflight` but never written to - only `ingest`/`quota:tick`
// ever incremented `used_requests`/`used_usd`. Twelve concurrent `run:start`
// calls against `limit_requests: 5` all succeeded (12/12), and so did eight
// sequential ones. Fixed in src/quota.mjs (`reserveRequest`, `reservedSpend`)
// and src/commands/runs.mjs (`doRunStart` reserves inside its own
// `withImmediateTransaction`, review round 1's F1 fix) and src/ingest.mjs
// (never double-counts a reserved run's request).
//
// F3 (major): `syncConfigQuota`'s find-or-insert (src/quota.mjs) was not
// atomic and had no lock; 12 concurrent `quota:show` calls on a
// never-before-seen window produced up to 3 duplicate `provider_quota` rows
// for the same (provider, model, window_kind). Fixed with a UNIQUE index
// (src/schema/006-v02-quota-reserve.mjs) plus `INSERT ... ON CONFLICT DO
// NOTHING` inside `withImmediateTransaction`.
//
// F7 (minor): removing a window from config left its `provider_quota` row
// enforcing the last synced limit forever, with no way to clear it. Fixed
// with `quota:clear --provider <p> [--model <m>] --window <kind>`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, makeTempGitRepo, makeTempDir, makeTempDb } from './helpers.mjs';
import { openDb, migrate } from '../src/db.mjs';
import { insertTask, insertRun, upsertQuota } from '../src/ledger.mjs';
import { checkQuota } from '../src/limits.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'bin', 'cortexctl.mjs');
const SCHEMA_DIR = join(HERE, '..', 'src', 'schema');

// ---------------------------------------------------------------------------
// Shared setup, same shape as test/quota-config.test.mjs and
// test/concurrency.test.mjs: config, db, and worktree in separate temp dirs.
// ---------------------------------------------------------------------------

function writeConfig(homeDir, { name = 'cortex-ledger.json', limits = {}, providers = {} } = {}) {
  const configPath = join(homeDir, name);
  writeFileSync(
    configPath,
    JSON.stringify({
      db: './ledger.db',
      runs: './runs',
      limits: {
        builder_attempts_max: 20, // high enough that attempts never masks the quota gate below
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

function setup(providers, limitsOverride) {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const configPath = writeConfig(homeDir, { providers, limits: limitsOverride });
  return { homeDir, dir, baseCommit, configPath, env: { ...process.env } };
}

function cli(args, ctx, configPath = ctx.configPath) {
  return runCli(['--config', configPath, ...args], { env: ctx.env });
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

/** Spawn one `run:start` process asynchronously (so N calls genuinely race, unlike spawnSync in a loop) - same pattern as test/concurrency.test.mjs. */
function spawnRunStart(configPath, taskId, provider, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, '--config', configPath, 'run:start', '--task', taskId, '--agent', 'solo', '--provider', provider, '--model', 'm1'],
      { env }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Spawn one `quota:show` process asynchronously. */
function spawnQuotaShow(configPath, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, '--config', configPath, 'quota:show', '--json'], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function taskEscalations(ctx, taskId) {
  const result = cli(['task:show', taskId, '--json'], ctx);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).escalations;
}

// ---------------------------------------------------------------------------
// F1(a): request admission gate, concurrent and sequential.
// ---------------------------------------------------------------------------

test('F1 concurrency: 12 concurrent run:start against a config-only limit_requests: 5 window admit exactly 5, refuse 7 with escalation quota, used_requests ends at 5', async () => {
  const ctx = setup({ racer: { windows: [{ kind: 'day', limit_requests: 5 }] } });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () => spawnRunStart(ctx.configPath, taskId, 'racer', ctx.env))
  );

  for (const r of results) {
    assert.doesNotMatch(
      r.stderr,
      /SQLITE_BUSY|database is locked/i,
      `a run:start process saw a busy-database error instead of waiting: ${r.stderr}`
    );
  }

  const succeeded = results.filter((r) => r.code === 0);
  const refused = results.filter((r) => r.code !== 0);
  assert.equal(
    succeeded.length,
    5,
    `expected exactly 5 successful run:start calls, got ${succeeded.length}: ${JSON.stringify(results, null, 2)}`
  );
  assert.equal(refused.length, N - 5, `every other call should be refused: ${JSON.stringify(results, null, 2)}`);
  for (const r of refused) {
    assert.equal(r.code, 4, `a refused call should exit 4 (quota): ${JSON.stringify(r)}`);
    assert.match(r.stderr, /^cortexctl: quota: /, r.stderr);
  }

  const escalations = taskEscalations(ctx, taskId).filter((e) => e.reason === 'quota');
  assert.equal(escalations.length, 7, `one quota escalation per refused call: ${JSON.stringify(escalations)}`);
  for (const e of escalations) assert.equal(e.severity, 'halt');

  const db = openDb(join(ctx.homeDir, 'ledger.db'));
  const row = db.prepare("SELECT used_requests FROM provider_quota WHERE provider = 'racer'").get();
  db.close();
  assert.equal(row.used_requests, 5, 'used_requests must end at exactly the limit, not below or above it');
});

test('F1 sequential: 6 run:start calls against a config-only limit_requests: 5 window - the 6th is refused', () => {
  const ctx = setup({ 'racer-seq': { windows: [{ kind: 'day', limit_requests: 5 }] } });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const results = [];
  for (let i = 0; i < 6; i++) {
    const r = cli(
      ['run:start', '--task', taskId, '--agent', 'solo', '--provider', 'racer-seq', '--model', 'm1'],
      ctx
    );
    results.push(r);
  }

  for (let i = 0; i < 5; i++) {
    assert.equal(results[i].code, 0, `run ${i + 1} should be admitted: ${results[i].stderr}`);
  }
  assert.equal(results[5].code, 4, `the 6th run must be refused: ${JSON.stringify(results[5])}`);
  assert.match(results[5].stderr, /^cortexctl: quota: /, results[5].stderr);

  const db = openDb(join(ctx.homeDir, 'ledger.db'));
  const row = db.prepare("SELECT used_requests FROM provider_quota WHERE provider = 'racer-seq'").get();
  db.close();
  assert.equal(row.used_requests, 5);
});

// ---------------------------------------------------------------------------
// F1(b): pessimistic reserved spend for limit_usd windows.
// ---------------------------------------------------------------------------

test('F1(b) reservation, real CLI: limits.spend_usd 4, window limit_usd 10 - with two runs already running and $3 of real usage, a third run:start is refused; quota:show prints the reserved_usd behind it', () => {
  const ctx = setup(
    { 'resvusd-test': { windows: [{ kind: 'day', limit_usd: 10 }] } },
    { spend_usd: 4 }
  );
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  // Real (already-ingested) usage of $1 against the window, well under the
  // $10 ceiling on its own.
  assert.equal(cli(['quota:tick', '--provider', 'resvusd-test', '--usd', '1'], ctx).code, 0);

  const start = () =>
    cli(['run:start', '--task', taskId, '--agent', 'solo', '--provider', 'resvusd-test', '--model', 'm1'], ctx);

  // Two runs admitted and left `running` (never ended) - each is now a
  // pessimistic $4 reservation against the window (arbitration 2026-09-08:
  // the admitting call's own share is reserved too, at max(projectedCost,
  // spend_usd), so the *first* call already commits used_usd + its own $4).
  const first = start();
  assert.equal(first.code, 0, first.stderr);
  const second = start();
  assert.equal(second.code, 0, second.stderr);

  // $1 real usage + this (third) call's own $4 reservation + 2 already
  // running runs x $4 reserved each = $13, over the $10 ceiling. Before the
  // arbitration fix, the admitting call's own share was not reserved at
  // all (only `reserved` for OTHER running runs), so this same setup would
  // have admitted a third run: $1 + $8 = $9 <= $10, three runs in flight
  // with $12 of potential exposure against a $10 ceiling.
  const third = start();
  assert.equal(third.code, 4, `expected the third run to be refused by reserved spend: ${third.stderr}`);
  assert.match(third.stderr, /^cortexctl: quota: /);
  assert.match(third.stderr, /reserved 8\.0000/, `refusal detail should show the $8 in-flight reservation from the two other running runs: ${third.stderr}`);

  const show = cli(['quota:show', '--json'], ctx);
  assert.equal(show.code, 0, show.stderr);
  const row = JSON.parse(show.stdout).find((r) => r.provider === 'resvusd-test');
  assert.ok(row, show.stdout);
  assert.equal(row.reserved_usd, 8, 'quota:show should print the same $8 reservation (2 running x $4)');
  assert.equal(row.used_usd, 1, 'real recorded usage is unaffected by the reservation');
});

test('F1(b) reservation, unit level: checkQuota adds no reservation when config.limits.spend_usd is unset', async () => {
  // config.mjs's real loader always fills limits.spend_usd with a positive
  // default (validateLimits rejects anything else), so "spend_usd unset" is
  // only reachable by calling checkQuota directly with a raw config object,
  // as every other checkQuota unit test in test/limits.test.mjs already
  // does - this is not reachable through the real CLI's config file.
  const db = openDb(makeTempDb());
  await migrate(db);
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  insertRun(db, { task_id: task.id, seq: 1, agent: 'solo', provider: 'resvusd-test2', model: 'm1', status: 'running' });
  insertRun(db, { task_id: task.id, seq: 2, agent: 'solo', provider: 'resvusd-test2', model: 'm1', status: 'running' });
  upsertQuota(db, { provider: 'resvusd-test2', window_kind: 'day', limit_usd: 10, used_usd: 3 });

  const configNoSpend = { limits: {}, providers: {} }; // limits.spend_usd is undefined
  const check = checkQuota(db, configNoSpend, 'resvusd-test2', 'm1', 0, { isPublic: false });
  assert.equal(check.ok, true, 'with no per-task budget to be pessimistic about, reservation must be 0');
  assert.equal(check.reservedUsd, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// F3: provider_quota duplicate-row race.
// ---------------------------------------------------------------------------

test('F3 concurrency: 12 concurrent quota:show calls on a fresh config-only window produce exactly one provider_quota row', async () => {
  const ctx = setup({ 'diamond-test': { windows: [{ kind: 'minute', limit_requests: 3 }] } });
  assert.equal(cli(['init'], ctx).code, 0);

  const N = 12;
  const results = await Promise.all(Array.from({ length: N }, () => spawnQuotaShow(ctx.configPath, ctx.env)));

  for (const r of results) {
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /SQLITE_BUSY|database is locked/i, r.stderr);
  }

  const db = openDb(join(ctx.homeDir, 'ledger.db'));
  const rows = db.prepare("SELECT * FROM provider_quota WHERE provider = 'diamond-test'").all();
  db.close();
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}: ${JSON.stringify(rows)}`);
});

test('F3 migration: dedupes pre-existing duplicate provider_quota rows and adds the (provider, model, window_kind) UNIQUE index', async () => {
  // Simulate a database created before the fix: apply only the base + v0.1
  // tables schema directly (same pattern as test/migration.test.mjs's
  // makeLegacyDb), then hand-insert duplicate rows the old, non-atomic
  // syncConfigQuota could have produced.
  const db = openDb(makeTempDb());
  db.exec(readFileSync(join(SCHEMA_DIR, '000-base.sql'), 'utf8'));
  db.exec(readFileSync(join(SCHEMA_DIR, '001-v01-tables.sql'), 'utf8'));

  const insert = db.prepare(
    `INSERT INTO provider_quota
       (id, provider, model, window_kind, window_started_at, limit_requests, limit_usd,
        used_requests, used_usd, source, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );

  // Group 1: a manual (quota:set) row among the duplicates must be kept,
  // regardless of its updated_at ordering, and used_* merged by MAX.
  insert.run('q_a', 'dup-provider', null, 'day', '2026-01-01T00:00:00.000Z', 10, null, 2, 1.0, 'config', '2026-01-01T00:00:00.000Z');
  insert.run('q_b', 'dup-provider', null, 'day', '2026-01-02T00:00:00.000Z', 10, null, 4, 2.0, 'ingest', '2026-01-02T00:00:00.000Z');
  insert.run('q_c', 'dup-provider', null, 'day', '2026-01-03T00:00:00.000Z', 99, null, 1, 0.5, 'manual', '2026-01-03T00:00:00.000Z');

  // Group 2: no manual row - the oldest by updated_at wins, used_* merged by MAX.
  insert.run('q_d', 'dup-provider2', null, 'week', '2026-02-02T00:00:00.000Z', 20, null, 1, 0, 'config', '2026-02-02T00:00:00.000Z');
  insert.run('q_e', 'dup-provider2', null, 'week', '2026-02-01T00:00:00.000Z', 20, null, 5, 3.0, 'config', '2026-02-01T00:00:00.000Z');
  insert.run('q_f', 'dup-provider2', null, 'week', '2026-02-03T00:00:00.000Z', 20, null, 2, 1.0, 'ingest', '2026-02-03T00:00:00.000Z');

  await migrate(db);

  const group1 = db.prepare("SELECT * FROM provider_quota WHERE provider = 'dup-provider'").all();
  assert.equal(group1.length, 1, `duplicates in group 1 should be merged into one row: ${JSON.stringify(group1)}`);
  assert.equal(group1[0].id, 'q_c', 'the manual row must be the one kept');
  assert.equal(group1[0].used_requests, 4, 'used_requests merged by MAX across the duplicates');
  assert.equal(group1[0].used_usd, 2.0, 'used_usd merged by MAX across the duplicates');
  assert.equal(group1[0].limit_requests, 99, "the kept row's own limit is untouched by the merge");

  const group2 = db.prepare("SELECT * FROM provider_quota WHERE provider = 'dup-provider2'").all();
  assert.equal(group2.length, 1, `duplicates in group 2 should be merged into one row: ${JSON.stringify(group2)}`);
  assert.equal(group2[0].id, 'q_e', 'with no manual row, the oldest by updated_at must be the one kept');
  assert.equal(group2[0].used_requests, 5);
  assert.equal(group2[0].used_usd, 3.0);

  // The UNIQUE index must now actually be enforced, not merely dedupe once.
  const index = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_quota_unique'")
    .get();
  assert.ok(index, 'idx_quota_unique should exist after migration');
  assert.throws(
    () => insert.run('q_g', 'dup-provider2', null, 'week', '2026-02-04T00:00:00.000Z', 20, null, 0, 0, 'config', '2026-02-04T00:00:00.000Z'),
    /UNIQUE constraint failed/i,
    'a second row for the same (provider, model, window_kind) key must now be rejected outright'
  );

  db.close();
});

// ---------------------------------------------------------------------------
// F7: clearing a stale provider_quota row.
// ---------------------------------------------------------------------------

test('F7: quota:clear deletes a manual window row outright, and quota:show no longer lists it', () => {
  const ctx = setup({}); // no config-declared providers at all
  assert.equal(cli(['init'], ctx).code, 0);
  assert.equal(
    cli(['quota:set', '--provider', 'clear-test', '--window', 'day', '--limit-requests', '7'], ctx).code,
    0
  );

  const before = JSON.parse(cli(['quota:show', '--json'], ctx).stdout);
  assert.ok(before.some((r) => r.provider === 'clear-test'), JSON.stringify(before));

  const cleared = cli(['quota:clear', '--provider', 'clear-test', '--window', 'day'], ctx);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.match(cleared.stdout, /deleted clear-test/);

  const after = JSON.parse(cli(['quota:show', '--json'], ctx).stdout);
  assert.ok(!after.some((r) => r.provider === 'clear-test'), JSON.stringify(after));

  // Clearing a window that was never set is a no-op, not an error.
  const clearAgain = cli(['quota:clear', '--provider', 'clear-test', '--window', 'day'], ctx);
  assert.equal(clearAgain.code, 0, clearAgain.stderr);
  assert.match(clearAgain.stdout, /no such quota window/);
});

test('F7: after quota:clear, syncing re-creates the row (fresh, zero usage) only while the window is still declared in config', () => {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const withWindow = writeConfig(homeDir, {
    name: 'with-window.json',
    providers: { 'clear-test2': { windows: [{ kind: 'day', limit_requests: 9 }] } },
  });
  const withoutWindow = writeConfig(homeDir, { name: 'without-window.json', providers: {} });
  const env = { ...process.env };
  const ctx = { homeDir, dir, baseCommit, configPath: withWindow, env };

  assert.equal(cli(['init'], ctx).code, 0);

  // First sync creates it from config.
  const created = JSON.parse(cli(['quota:show', '--json'], ctx).stdout);
  const row = created.find((r) => r.provider === 'clear-test2');
  assert.ok(row, JSON.stringify(created));
  assert.equal(row.source, 'config');

  // Record some usage, then clear the row outright. Checking with
  // `withoutWindow` here (rather than `ctx`'s own `withWindow`) is
  // deliberate: `quota:show` always re-syncs from config before listing, so
  // asking it with a config that still declares the window would recreate
  // the row before the check ever ran and defeat the point of this
  // assertion - the absence must be observed against a config that cannot
  // itself resurrect it.
  assert.equal(cli(['quota:tick', '--provider', 'clear-test2', '--requests', '3'], ctx).code, 0);
  assert.equal(cli(['quota:clear', '--provider', 'clear-test2', '--window', 'day'], ctx).code, 0);
  const afterClear = JSON.parse(cli(['quota:show', '--json'], ctx, withoutWindow).stdout);
  assert.ok(!afterClear.some((r) => r.provider === 'clear-test2'), JSON.stringify(afterClear));

  // Syncing again while the window is still in config re-creates a fresh
  // row (usage reset to zero, not the $3/3-requests it had before clearing).
  const recreated = JSON.parse(cli(['quota:show', '--json'], ctx, withWindow).stdout);
  const freshRow = recreated.find((r) => r.provider === 'clear-test2');
  assert.ok(freshRow, JSON.stringify(recreated));
  assert.equal(freshRow.used_requests, 0, 'the re-created row must start at zero usage, not resurrect the old row');

  // Clear it again, then sync against a config that no longer declares the
  // window at all: it must stay gone.
  assert.equal(cli(['quota:clear', '--provider', 'clear-test2', '--window', 'day'], ctx).code, 0);
  const staysGone = JSON.parse(cli(['quota:show', '--json'], ctx, withoutWindow).stdout);
  assert.ok(!staysGone.some((r) => r.provider === 'clear-test2'), JSON.stringify(staysGone));
});
