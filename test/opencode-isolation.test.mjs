// Review round 1, F4 (major): "OpenCode isolation". Two behaviours:
//
//   1. run:launch computes `dataHome = join(config.runs, '.opencode-data',
//      agent)`, creates the directory, and passes it to opencode's
//      buildArgv - not just unit-tested in isolation (buildArgv's own
//      XDG_DATA_HOME wiring is already covered by test/adapters.test.mjs)
//      but actually wired end to end from the command.
//   2. `config.opencode_serial` (default false): when true, run:start for
//      adapter opencode refuses (exit 6, reason opencode_serial) while any
//      task_runs row anywhere in the ledger is `running` with
//      `adapter = 'opencode'`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');

function makeConfig(dir, extra = {}) {
  const configPath = join(dir, 'cortex-ledger.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      db: './ledger.db',
      runs: './runs',
      limits: {
        builder_attempts_max: 3,
        challenge_cycles_max: 1,
        wallclock_s: 5400,
        spend_usd: 5.0,
        files_touched_max: 10,
        stall_s: 900,
      },
      ...extra,
    })
  );
  return configPath;
}

function setup(extra = {}) {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const configPath = makeConfig(homeDir, extra);
  return { homeDir, dir, baseCommit, configPath, env: { ...process.env } };
}

function cli(args, ctx, envOverride) {
  return runCli(['--config', ctx.configPath, ...args], { env: envOverride ?? ctx.env });
}

function newTask(ctx) {
  const result = cli(
    ['task:new', '--repo', 'o/n', '--title', 't', '--class', 'ci', '--arm', 'control', '--worktree', ctx.dir, '--base', ctx.baseCommit],
    ctx
  );
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// 1. dataHome isolation
// ---------------------------------------------------------------------------

test('run:launch (opencode): dataHome = <runs>/.opencode-data/<agent> is created and threaded through to XDG_DATA_HOME', async () => {
  const stubPath = join(FIXTURES_DIR, 'stub-opencode-datahome.mjs');
  const ctx = setup({ adapters: { opencode: { cmd: process.execPath, argsPrefix: [stubPath] } } });
  assert.equal(cli(['init'], ctx).code, 0);
  const taskId = newTask(ctx);

  const promptPath = join(ctx.homeDir, 'prompt.txt');
  writeFileSync(promptPath, 'do the thing');
  const seenPath = join(ctx.homeDir, 'seen-env.json');

  const launch = cli(
    [
      'run:launch', '--task', taskId, '--agent', 'builder', '--adapter', 'opencode',
      '--provider', 'opencode-go', '--model', 'opencode/stub-model', '--prompt-file', promptPath,
    ],
    ctx,
    { ...ctx.env, CORTEX_TEST_DATAHOME_OUT: seenPath }
  );
  assert.equal(launch.code, 0, launch.stderr);
  const runId = launch.stdout.trim();

  const outDir = join(ctx.homeDir, 'runs', taskId, 'builder');
  const done = await waitFor(() => existsSync(join(outDir, 'done.marker')));
  assert.ok(done, `done.marker never appeared in ${outDir}`);

  const expectedDataHome = join(ctx.homeDir, 'runs', '.opencode-data', 'builder');
  assert.ok(existsSync(expectedDataHome), `run:launch should have created ${expectedDataHome}`);
  // opencode.mjs's buildArgv joins `agent` onto `dataHome` itself, so
  // run:launch passes the *base* dir through and the spawned process's
  // XDG_DATA_HOME (set inside buildArgv) is base/<agent> - the same
  // directory this test just asserted was created.

  const ok = await waitFor(() => existsSync(seenPath));
  assert.ok(ok, 'the stub should have written the env it saw');
  const seen = JSON.parse(readFileSync(seenPath, 'utf8'));
  assert.equal(seen.XDG_DATA_HOME, expectedDataHome, 'the spawned process should see XDG_DATA_HOME = dataHome/agent');

  assert.match(runId, /^r_/);
});

// ---------------------------------------------------------------------------
// 2. opencode_serial
// ---------------------------------------------------------------------------

test('run:start: opencode_serial off (default) allows two concurrent opencode runs', () => {
  const ctx = setup();
  assert.equal(cli(['init'], ctx).code, 0);

  const taskA = newTask(ctx);
  const first = cli(
    ['run:start', '--task', taskA, '--agent', 'builder', '--adapter', 'opencode', '--provider', 'opencode-go', '--model', 'opencode/x'],
    ctx
  );
  assert.equal(first.code, 0, first.stderr);

  const taskB = newTask(ctx);
  const second = cli(
    ['run:start', '--task', taskB, '--agent', 'builder', '--adapter', 'opencode', '--provider', 'opencode-go', '--model', 'opencode/x'],
    ctx
  );
  assert.equal(second.code, 0, second.stderr);
});

test('run:start: opencode_serial on refuses a second concurrent opencode run with exit 6', () => {
  const ctx = setup({ opencode_serial: true });
  assert.equal(cli(['init'], ctx).code, 0);

  const taskA = newTask(ctx);
  const first = cli(
    ['run:start', '--task', taskA, '--agent', 'builder', '--adapter', 'opencode', '--provider', 'opencode-go', '--model', 'opencode/x'],
    ctx
  );
  assert.equal(first.code, 0, first.stderr);

  const taskB = newTask(ctx);
  const second = cli(
    ['run:start', '--task', taskB, '--agent', 'builder', '--adapter', 'opencode', '--provider', 'opencode-go', '--model', 'opencode/x'],
    ctx
  );
  assert.equal(second.code, 6, second.stderr);
  assert.match(second.stderr, /opencode_serial/);

  // A non-opencode adapter is never refused by this dial.
  const taskC = newTask(ctx);
  const third = cli(['run:start', '--task', taskC, '--agent', 'builder', '--provider', 'fake', '--model', 'm'], ctx);
  assert.equal(third.code, 0, third.stderr);
});

test('run:start: opencode_serial on allows a second opencode run once the first is no longer running', () => {
  const ctx = setup({ opencode_serial: true });
  assert.equal(cli(['init'], ctx).code, 0);

  const taskA = newTask(ctx);
  const first = cli(
    ['run:start', '--task', taskA, '--agent', 'builder', '--adapter', 'opencode', '--provider', 'opencode-go', '--model', 'opencode/x'],
    ctx
  );
  assert.equal(first.code, 0, first.stderr);
  const firstRunId = first.stdout.trim();

  assert.equal(cli(['run:end', '--run', firstRunId, '--exit', '0'], ctx).code, 0);

  const taskB = newTask(ctx);
  const second = cli(
    ['run:start', '--task', taskB, '--agent', 'builder', '--adapter', 'opencode', '--provider', 'opencode-go', '--model', 'opencode/x'],
    ctx
  );
  assert.equal(second.code, 0, second.stderr);
});
