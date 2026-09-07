import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';
import { openDb } from '../src/db.mjs';
import { insertTask, insertRun, insertCost } from '../src/ledger.mjs';

function makeConfig(dir, limitsOverride = {}, extra = {}) {
  const configPath = join(dir, 'cortex-ledger.json');
  const config = {
    db: './ledger.db',
    runs: './runs',
    limits: {
      builder_attempts_max: 3,
      challenge_cycles_max: 1,
      wallclock_s: 5400,
      spend_usd: 5.0,
      files_touched_max: 10,
      stall_s: 900,
      ...limitsOverride,
    },
    ...extra,
  };
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// The config file, database, and any fixture/prompt files live under a
// separate `homeDir`, never inside the git worktree itself - otherwise
// `git ls-files --others --exclude-standard` (used by the files_touched
// guard) would pick up the kit's own scratch files as if the agent had
// touched them.
function setup(limitsOverride = {}, extra = {}) {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const configPath = makeConfig(homeDir, limitsOverride, extra);
  const dbPath = join(homeDir, 'ledger.db');
  return { homeDir, dir, baseCommit, configPath, dbPath, env: { ...process.env } };
}

function cli(args, ctx, envOverride) {
  return runCli(['--config', ctx.configPath, ...args], { env: envOverride ?? ctx.env });
}

function newTask(ctx, extraFlags = []) {
  const result = cli(
    ['task:new', '--repo', 'o/n', '--title', 't', '--class', 'ci', '--arm', 'control',
     '--worktree', ctx.dir, '--base', ctx.baseCommit, ...extraFlags],
    ctx
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function taskShow(ctx, taskId) {
  const result = cli(['task:show', taskId, '--json'], ctx);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// run:start
// ---------------------------------------------------------------------------

test('run:start: happy path inserts a running run, moves the task to working, prints a bare run id', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const start = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'fake-model'], ctx);
  assert.equal(start.code, 0, start.stderr);
  assert.equal(start.stderr, '');
  const runId = start.stdout.trim();
  assert.match(runId, /^r_/);

  const view = taskShow(ctx, taskId);
  assert.equal(view.task.status, 'working');
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0].status, 'running');
  assert.equal(view.runs[0].agent, 'builder');
});

test('run:start: rejects a missing task with exit 1', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const result = cli(['run:start', '--task', 't_doesnotexist', '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx);
  assert.equal(result.code, 1);
});

test('run:start: refuses on a task in a terminal state with exit 6', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);
  assert.equal(cli(['task:reject', '--task', taskId, '--note', 'not doing this'], ctx).code, 0);

  const start = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx);
  assert.equal(start.code, 6);
  assert.match(start.stderr, /task_state/);
});

test('run:start: fourth builder attempt exits 3 with reason retry_limit and writes a halt escalation', () => {
  const ctx = setup({ builder_attempts_max: 1 });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const first = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx);
  assert.equal(first.code, 0, first.stderr);

  const second = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx);
  assert.equal(second.code, 3);
  assert.match(second.stderr, /retry_limit/);

  const view = taskShow(ctx, taskId);
  assert.equal(view.task.status, 'input_required');
  assert.ok(view.escalations.some((e) => e.reason === 'retry_limit' && e.severity === 'halt'));
});

test('run:start: task:resolve --retry-authorized raises the ceiling by one and allows another attempt', () => {
  const ctx = setup({ builder_attempts_max: 1 });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);
  assert.equal(cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx).code, 0);
  assert.equal(cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx).code, 3);

  const resolved = cli(['task:resolve', '--task', taskId, '--retry-authorized', '--note', 'one more'], ctx);
  assert.equal(resolved.code, 0, resolved.stderr);
  assert.equal(taskShow(ctx, taskId).task.status, 'working');

  const third = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx);
  assert.equal(third.code, 0, third.stderr);
});

test('run:start: budget gate refuses when projected spend would exceed spend_usd', () => {
  const ctx = setup({ spend_usd: 5 });
  assert.equal(cli(['init'], ctx).code, 0);

  // Seed ledger history: three ended builder/fake-model runs elsewhere at
  // $2.00 each, so the median projected cost of one more is $2.00.
  const db1 = openDb(ctx.dbPath);
  const history = insertTask(db1, { repo: 'o/n', title: 'history', task_class: 'ci', arm: 'control' });
  for (let i = 0; i < 3; i++) {
    insertRun(db1, {
      task_id: history.id, seq: i + 1, agent: 'builder', provider: 'fake', model: 'fake-model',
      status: 'ok', cost_usd: 2.0,
    });
  }
  db1.close();

  const taskId = newTask(ctx);
  const db2 = openDb(ctx.dbPath);
  insertCost(db2, { task_id: taskId, provider: 'fake', model: 'fake-model', cost_usd: 4.0 });
  db2.close();

  const start = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'fake-model'], ctx);
  assert.equal(start.code, 3);
  assert.match(start.stderr, /budget/);

  const view = taskShow(ctx, taskId);
  assert.equal(view.task.status, 'input_required');
  assert.ok(view.escalations.some((e) => e.reason === 'budget' && e.severity === 'halt'));
});

test('run:start: quota gate refuses with exit 4 when the provider window has no headroom', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  assert.equal(cli(['quota:set', '--provider', 'google', '--window', 'day', '--limit-requests', '0'], ctx).code, 0);
  const taskId = newTask(ctx);

  const start = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'google', '--model', 'm'], ctx);
  assert.equal(start.code, 4);
  assert.match(start.stderr, /quota/);

  const view = taskShow(ctx, taskId);
  assert.ok(view.escalations.some((e) => e.reason === 'quota'));
});

test('run:start: --no-preflight skips the guard and records preflight_skipped on the run', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  writeFileSync(join(ctx.dir, 'dirty.txt'), 'uncommitted\n');

  // Demonstrate the guard would otherwise refuse this worktree via the
  // standalone `preflight` command, so this does not itself push a task
  // into input_required and confound the next assertion.
  const standalone = cli(['preflight', '--worktree', ctx.dir, '--provider', 'fake', '--strict'], ctx);
  assert.equal(standalone.code, 2);

  const taskId = newTask(ctx);
  const skipped = cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'm', '--no-preflight'], ctx);
  assert.equal(skipped.code, 0, skipped.stderr);

  const view = taskShow(ctx, taskId);
  assert.equal(view.runs[0].halted_reason, 'preflight_skipped');
});

// ---------------------------------------------------------------------------
// run:launch + run:end (fake adapter)
// ---------------------------------------------------------------------------

// docs/architecture.md's runtime layout puts patch.diff in the run's own
// out_dir (<runs>/<task>/builder/patch.diff), not the worktree - a real
// harness writes its diff there itself. fake.mjs's fixture `files` map
// writes into `cwd` (the worktree) for a relative key, or straight to an
// absolute path otherwise, so route the conventional 'patch.diff' fixture
// key to the run's actual out_dir; every other key still lands in the
// worktree, simulating the agent's real code changes there.
function launchWithFixture(ctx, taskId, fixture, extraFlags = []) {
  const outDir = join(ctx.homeDir, 'runs', taskId, 'builder');
  const resolvedFixture = { ...fixture };
  if (fixture.files) {
    resolvedFixture.files = Object.fromEntries(
      Object.entries(fixture.files).map(([key, value]) =>
        key === 'patch.diff' ? [join(outDir, 'patch.diff'), value] : [key, value]
      )
    );
  }
  const fixturePath = join(ctx.homeDir, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixturePath, JSON.stringify(resolvedFixture));
  const promptPath = join(ctx.homeDir, 'prompt.txt');
  writeFileSync(promptPath, 'do the thing');
  // --sync (review round 1, F2): run:launch's default path now spawns even
  // the fake adapter detached through runner.mjs, same as every real
  // adapter; --sync keeps the old in-process, run-to-completion-before-
  // returning behaviour this test's immediately following run:end relies on.
  return cli(
    ['run:launch', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'fake-model',
     '--adapter', 'fake', '--sync', '--prompt-file', promptPath, ...extraFlags],
    ctx,
    { ...ctx.env, CORTEX_FAKE_FIXTURE: fixturePath }
  );
}

test('run:launch + run:end: clean exit with a patch produces an ok run', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const launch = launchWithFixture(ctx, taskId, {
    exitCode: 0,
    events: [{ ts: '2026-01-01T00:00:00.000Z', type: 'session.start' }],
    files: { 'patch.diff': 'diff --git a/x b/x\n+hello\n' },
  });
  assert.equal(launch.code, 0, launch.stderr);
  const runId = launch.stdout.trim();

  const end = cli(['run:end', '--run', runId], ctx);
  assert.equal(end.code, 0, end.stderr);
  assert.equal(end.stdout.trim(), 'ok');
});

test('run:end: files_touched over the limit halts the run and writes a halt escalation', () => {
  const ctx = setup({ files_touched_max: 1 });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const launch = launchWithFixture(ctx, taskId, {
    exitCode: 0,
    files: { 'patch.diff': 'diff\n', 'a.txt': '1', 'b.txt': '2' },
  });
  assert.equal(launch.code, 0, launch.stderr);
  const runId = launch.stdout.trim();

  const end = cli(['run:end', '--run', runId], ctx);
  assert.equal(end.code, 0, end.stderr);
  assert.equal(end.stdout.trim(), 'halted');

  const view = taskShow(ctx, taskId);
  assert.ok(view.escalations.some((e) => e.reason === 'files_touched' && e.severity === 'halt'));
  assert.equal(view.task.status, 'input_required');
});

test('run:end: touching a test file on a non-tests task writes a warn escalation but still passes', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const launch = launchWithFixture(ctx, taskId, {
    exitCode: 0,
    files: { 'patch.diff': 'diff\n', 'test/foo.test.mjs': 'edited test' },
  });
  const runId = launch.stdout.trim();
  const end = cli(['run:end', '--run', runId], ctx);
  assert.equal(end.stdout.trim(), 'ok');

  const view = taskShow(ctx, taskId);
  assert.ok(view.escalations.some((e) => e.reason === 'test_edit' && e.severity === 'warn'));
  assert.equal(view.task.status, 'working', 'a warn escalation must not move the task to input_required');
});

test('run:end: a tool failure streak writes a warn escalation but still passes', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const events = [
    { type: 'tool.result', tool: 'bash', ok: false, error: 'e1' },
    { type: 'tool.result', tool: 'bash', ok: false, error: 'e2' },
    { type: 'tool.result', tool: 'bash', ok: false, error: 'e3' },
  ];
  const launch = launchWithFixture(ctx, taskId, {
    exitCode: 0,
    events,
    files: { 'patch.diff': 'diff\n' },
  });
  const runId = launch.stdout.trim();
  const end = cli(['run:end', '--run', runId], ctx);
  assert.equal(end.stdout.trim(), 'ok');

  const view = taskShow(ctx, taskId);
  assert.ok(view.escalations.some((e) => e.reason === 'tool_failure' && e.severity === 'warn'));
});

test('run:end: a SCOPE_EXCEEDED marker in out.txt fails the run regardless of exit code', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const launch = launchWithFixture(ctx, taskId, {
    exitCode: 0,
    out: 'working...\nSCOPE_EXCEEDED too many files\n',
    files: { 'patch.diff': 'diff\n' },
  });
  const runId = launch.stdout.trim();
  const end = cli(['run:end', '--run', runId], ctx);
  assert.equal(end.stdout.trim(), 'fail');

  const view = taskShow(ctx, taskId);
  assert.match(view.runs[0].halted_reason, /SCOPE_EXCEEDED/);
});

test('run:end: builder exit 0 without a non-empty patch.diff fails with halted_reason no_patch', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const launch = launchWithFixture(ctx, taskId, { exitCode: 0 });
  const runId = launch.stdout.trim();
  const end = cli(['run:end', '--run', runId], ctx);
  assert.equal(end.stdout.trim(), 'fail');

  const view = taskShow(ctx, taskId);
  assert.equal(view.runs[0].halted_reason, 'no_patch');
});

// ---------------------------------------------------------------------------
// msg, artifact, test, intervene
// ---------------------------------------------------------------------------

test('msg: inserts an agent message and accepts a literal body', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);
  const result = cli(['msg', '--task', taskId, '--kind', 'brief', '--from', 'architect', '--to', 'builder', '--body', 'fix the bug'], ctx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^m_/);
});

test('artifact: inserts an artifact and computes sha256/bytes for a real file', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);
  const filePath = join(ctx.dir, 'diff.patch');
  writeFileSync(filePath, 'diff --git a/x b/x\n');
  const result = cli(['artifact', '--task', taskId, '--kind', 'diff', '--path', filePath], ctx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^a_/);
});

test('test: records a suite result', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);
  const result = cli(['test', '--task', taskId, '--suite', 'unit', '--status', 'pass', '--passed', '10', '--failed', '0'], ctx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^s_/);
});

test('intervene: records a human intervention', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);
  const result = cli(['intervene', '--task', taskId, '--kind', 'rescue', '--minutes', '15', '--detail', 'unstuck the agent'], ctx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^h_/);
});

// ---------------------------------------------------------------------------
// task:close, task:resolve, task:reject
// ---------------------------------------------------------------------------

test('task:close: implement task without a test_results row refuses with exit 6', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx, ['--kind', 'implement']);
  const close = cli(['task:close', '--task', taskId, '--outcome', 'first_pass'], ctx);
  assert.equal(close.code, 6);
  assert.match(close.stderr, /close_gate/);
});

test('task:close: --no-tests satisfies the close gate for an implement task', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx, ['--kind', 'implement']);
  const close = cli(['task:close', '--task', taskId, '--outcome', 'first_pass', '--no-tests'], ctx);
  assert.equal(close.code, 0, close.stderr);
  assert.equal(taskShow(ctx, taskId).task.status, 'completed');
});

test('task:close: a recorded test_results row satisfies the close gate', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx, ['--kind', 'implement']);
  assert.equal(cli(['test', '--task', taskId, '--suite', 'unit', '--status', 'pass'], ctx).code, 0);
  const close = cli(['task:close', '--task', taskId, '--outcome', 'revised'], ctx);
  assert.equal(close.code, 0, close.stderr);
  assert.equal(taskShow(ctx, taskId).task.status, 'completed');
});

test('task:close: an open halt escalation blocks closing until resolved', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  assert.equal(cli(['quota:set', '--provider', 'google', '--window', 'day', '--limit-requests', '0'], ctx).code, 0);
  const taskId = newTask(ctx, ['--kind', 'ops']);
  cli(['run:start', '--task', taskId, '--agent', 'builder', '--provider', 'google', '--model', 'm'], ctx);
  assert.equal(taskShow(ctx, taskId).task.status, 'input_required');

  const closeBlocked = cli(['task:close', '--task', taskId, '--outcome', 'failed'], ctx);
  assert.equal(closeBlocked.code, 6);

  assert.equal(cli(['task:resolve', '--task', taskId, '--note', 'quota bumped'], ctx).code, 0);
  const closeAfter = cli(['task:close', '--task', taskId, '--outcome', 'failed'], ctx);
  assert.equal(closeAfter.code, 0, closeAfter.stderr);
  assert.equal(taskShow(ctx, taskId).task.status, 'failed');
});

test('task:close: abandoned outcome cancels the task and prints a compare hint when a sibling exists', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const sibling = newTask(ctx);
  const taskId = newTask(ctx, ['--kind', 'ops', '--sibling', sibling]);
  const close = cli(['task:close', '--task', taskId, '--outcome', 'abandoned'], ctx);
  assert.equal(close.code, 0, close.stderr);
  assert.match(close.stdout, /compare hint/);
  assert.equal(taskShow(ctx, taskId).task.status, 'canceled');
});

test('task:reject: moves a submitted task to rejected; refuses from a non-submitted state with exit 6', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);
  const reject = cli(['task:reject', '--task', taskId, '--note', 'not worth it'], ctx);
  assert.equal(reject.code, 0, reject.stderr);
  assert.equal(taskShow(ctx, taskId).task.status, 'rejected');

  const other = newTask(ctx);
  cli(['run:start', '--task', other, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx);
  const rejectWorking = cli(['task:reject', '--task', other, '--note', 'too late'], ctx);
  assert.equal(rejectWorking.code, 6);
});
