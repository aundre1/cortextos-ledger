import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(HERE, '..', 'src', 'adapters', 'runner.mjs');

function runRunner(args, opts = {}) {
  return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
    ...opts,
  });
}

test('runner: runs a quick command to completion and writes all expected files', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();

  const result = runRunner([
    '--out', outDir,
    '--cwd', cwd,
    '--',
    process.execPath, '-e', 'setTimeout(() => { console.log("done"); }, 50);',
  ]);
  assert.equal(result.status, 0, result.stderr);

  assert.ok(existsSync(join(outDir, 'pid.txt')));
  assert.ok(existsSync(join(outDir, 'out.txt')));
  assert.ok(existsSync(join(outDir, 'exit.txt')));
  assert.ok(existsSync(join(outDir, 'elapsed_ms.txt')));
  assert.ok(existsSync(join(outDir, 'done.marker')));

  const pid = Number(readFileSync(join(outDir, 'pid.txt'), 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 0);

  const exitCode = Number(readFileSync(join(outDir, 'exit.txt'), 'utf8').trim());
  assert.equal(exitCode, 0);

  const elapsedMs = Number(readFileSync(join(outDir, 'elapsed_ms.txt'), 'utf8').trim());
  assert.ok(elapsedMs >= 0);

  const out = readFileSync(join(outDir, 'out.txt'), 'utf8');
  assert.match(out, /done/);
});

test('runner: propagates a non-zero exit code from the child', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();

  const result = runRunner([
    '--out', outDir,
    '--cwd', cwd,
    '--',
    process.execPath, '-e', 'process.exit(7);',
  ]);
  assert.equal(result.status, 0);

  const exitCode = Number(readFileSync(join(outDir, 'exit.txt'), 'utf8').trim());
  assert.equal(exitCode, 7);
});

test('runner: a tiny timeout kills the tree and writes exit code 137', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();

  const result = runRunner([
    '--out', outDir,
    '--cwd', cwd,
    '--timeout-ms', '100',
    '--',
    process.execPath, '-e', 'setTimeout(() => {}, 30000);',
  ], { timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);

  const exitCode = Number(readFileSync(join(outDir, 'exit.txt'), 'utf8').trim());
  assert.equal(exitCode, 137);
  assert.ok(existsSync(join(outDir, 'done.marker')));
});
