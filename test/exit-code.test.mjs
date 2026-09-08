// Phase 1a real-batch fix F3: a Windows unsigned exit code (4294967295,
// 0xFFFFFFFF - a native -1) must be normalized to its signed value before
// it ever reaches the ledger. src/exit-code.mjs's unit behaviour, plus an
// end-to-end proof through `run:end --exit`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeExitCode } from '../src/exit-code.mjs';
import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';

test('normalizeExitCode: the real production value (4294967295) becomes -1', () => {
  assert.equal(normalizeExitCode(4294967295), -1);
});

test('normalizeExitCode: other unsigned-32-bit values above INT32_MAX convert the same way', () => {
  assert.equal(normalizeExitCode(4294967295 - 136), -137); // a killed process's own -137 reported unsigned
  assert.equal(normalizeExitCode(2147483648), -2147483648); // INT32_MIN as unsigned
});

test('normalizeExitCode: ordinary exit codes, 0, and null/undefined pass through unchanged', () => {
  assert.equal(normalizeExitCode(0), 0);
  assert.equal(normalizeExitCode(1), 1);
  assert.equal(normalizeExitCode(137), 137);
  assert.equal(normalizeExitCode(2147483647), 2147483647); // INT32_MAX itself is a legitimate value, not converted
  assert.equal(normalizeExitCode(null), null);
  assert.equal(normalizeExitCode(undefined), undefined);
  assert.equal(normalizeExitCode(-1), -1); // already signed - never double-converted
});

test('normalizeExitCode: non-integer/non-finite input is returned unchanged, never coerced', () => {
  assert.equal(normalizeExitCode(NaN), NaN);
  assert.equal(normalizeExitCode('4294967295'), '4294967295');
  assert.equal(normalizeExitCode(1.5), 1.5);
});

function makeConfig(dir) {
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
    })
  );
  return configPath;
}

test('run:end --exit 4294967295: the Windows unsigned exit code is normalized to -1 in the ledger', () => {
  const homeDir = makeTempDir();
  const { dir: worktree, baseCommit } = makeTempGitRepo();
  const configPath = makeConfig(homeDir);
  const cli = (args) => runCli(['--config', configPath, ...args], { env: process.env });

  assert.equal(cli(['init']).code, 0);
  const taskResult = cli([
    'task:new', '--repo', 'acme/widgets', '--title', 'x', '--class', 'ci', '--arm', 'control',
    '--worktree', worktree, '--base', baseCommit,
  ]);
  assert.equal(taskResult.code, 0, taskResult.stderr);
  const taskId = taskResult.stdout.trim();

  const startResult = cli(['run:start', '--task', taskId, '--agent', 'solo', '--provider', 'fake', '--model', 'fake-model']);
  assert.equal(startResult.code, 0, startResult.stderr);
  const runId = startResult.stdout.trim();

  const endResult = cli(['run:end', '--run', runId, '--exit', '4294967295']);
  assert.equal(endResult.code, 0, endResult.stderr);

  const view = JSON.parse(cli(['task:show', taskId, '--json']).stdout);
  assert.equal(view.runs[0].exit_code, -1);
});
