// Review round 1, F1 (blocker): "atomic limit gates". 12 concurrent
// `cortexctl run:start --agent builder` processes racing one task with
// `builder_attempts_max` 3 must produce exactly 3 running builder runs, not
// more - a limit that fails under concurrency is not a limit
// (.claude/tasks/PLAN-REVIEW-LOG.md). This is a real multi-process race:
// each `run:start` is spawned as its own OS process with its own
// node:sqlite connection to the same db file, exactly like an operator
// running several orchestrator scripts at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';
import { openDb } from '../src/db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'bin', 'cortexctl.mjs');

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

/** Spawn one `node bin/cortexctl.mjs run:start ...` process, collecting its result asynchronously (so all 12 genuinely race, unlike spawnSync in a loop). */
function spawnRunStart(configPath, taskId, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, '--config', configPath, 'run:start', '--task', taskId, '--agent', 'builder', '--provider', 'fake', '--model', 'fake-model'],
      { env }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('run:start: 12 concurrent processes against builder_attempts_max 3 insert exactly 3 runs, seq 1..3 with no duplicates, no SQLITE_BUSY', async () => {
  const homeDir = makeTempDir();
  const { dir: worktree, baseCommit } = makeTempGitRepo();
  const configPath = makeConfig(homeDir);
  const env = { ...process.env };

  assert.equal(runCli(['--config', configPath, 'init'], { env }).code, 0);
  const newTask = runCli(
    [
      '--config', configPath, 'task:new', '--repo', 'o/n', '--title', 'race me', '--class', 'ci',
      '--arm', 'control', '--worktree', worktree, '--base', baseCommit,
    ],
    { env }
  );
  assert.equal(newTask.code, 0, newTask.stderr);
  const taskId = newTask.stdout.trim();

  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, () => spawnRunStart(configPath, taskId, env))
  );

  // "database is locked" is node:sqlite's own message text for SQLITE_BUSY -
  // PRAGMA busy_timeout (src/db.mjs's openDb) exists precisely so a
  // concurrent writer waits instead of a caller ever seeing either.
  for (const r of results) {
    assert.doesNotMatch(
      r.stderr,
      /SQLITE_BUSY|database is locked/i,
      `a run:start process saw a busy-database error instead of waiting: ${r.stderr}`
    );
  }

  const succeeded = results.filter((r) => r.code === 0);
  const refused = results.filter((r) => r.code === 3);
  assert.equal(
    succeeded.length,
    3,
    `expected exactly 3 successful run:start calls, got ${succeeded.length}: ${JSON.stringify(results, null, 2)}`
  );
  assert.equal(refused.length, N - 3, `every other call should exit 3 (retry_limit): ${JSON.stringify(results, null, 2)}`);
  for (const r of refused) {
    assert.match(r.stderr, /retry_limit/, `refused call's stderr should name retry_limit: ${r.stderr}`);
  }

  const db = openDb(join(homeDir, 'ledger.db'));
  const runs = db.prepare('SELECT seq, status FROM task_runs WHERE task_id = ? ORDER BY seq').all(taskId);
  db.close();

  assert.equal(runs.length, 3, 'exactly 3 task_runs rows should exist');
  assert.deepEqual(runs.map((r) => r.seq), [1, 2, 3], 'seq values must be 1, 2, 3 with no duplicates or gaps');
  assert.ok(runs.every((r) => r.status === 'running'), 'every inserted run should be running');
});
