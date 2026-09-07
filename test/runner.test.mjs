import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

// Review round 1, F3 (major): "redaction at rest" - every line written to
// out.txt passes through redact() before it hits disk, not only after the
// whole run has finished (see also test/launch-real-path.test.mjs, which
// covers the same thing through the full run:launch CLI path for every real
// adapter).
test('runner: a line with an sk-ant- style key printed to stdout is redacted before it is written to out.txt (F3)', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();
  const secret = `sk-ant-${'a'.repeat(24)}`;

  const result = runRunner([
    '--out', outDir,
    '--cwd', cwd,
    '--',
    process.execPath, '-e', `console.log('token ${secret} leaked in the clear')`,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const out = readFileSync(join(outDir, 'out.txt'), 'utf8');
  assert.ok(out.includes('[REDACTED]'), `expected [REDACTED] in out.txt, got: ${out}`);
  assert.equal(out.includes(secret), false, `out.txt must never contain the raw secret, got: ${out}`);
});

// Review round 1, F5 (minor): "exit.txt precedence" - the watchdog
// (src/guards/watchdog.mjs) can write exit.txt = 137 after killing the
// process tree, strictly before this runner's own child.on('close') fires;
// that value must win.
test('runner: exit.txt is written only once - a pre-existing 137 (the watchdog\'s kill code) is never overwritten (F5)', async () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();

  const child = spawn(
    process.execPath,
    [RUNNER_PATH, '--out', outDir, '--cwd', cwd, '--', process.execPath, '-e', 'setTimeout(() => {}, 300);'],
    { stdio: 'ignore' }
  );

  // Simulate the watchdog: by the time the runner's out dir exists and the
  // child has been spawned, but well before the child's own 300ms timer
  // fires and the runner's close handler runs, write exit.txt = 137 exactly
  // as src/guards/watchdog.mjs's ensureExitCode does after a kill.
  const deadline = Date.now() + 2000;
  while (!existsSync(outDir) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  writeFileSync(join(outDir, 'exit.txt'), '137');

  await new Promise((resolve) => child.on('close', resolve));

  assert.ok(existsSync(join(outDir, 'done.marker')));
  const exitCode = readFileSync(join(outDir, 'exit.txt'), 'utf8').trim();
  assert.equal(exitCode, '137', "the runner's own close handler must not overwrite an exit.txt that already exists");
});

test('runner: normal completion (no pre-existing exit.txt) still writes the real exit code', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();

  const result = runRunner(['--out', outDir, '--cwd', cwd, '--', process.execPath, '-e', 'process.exit(3);']);
  assert.equal(result.status, 0, result.stderr);

  const exitCode = readFileSync(join(outDir, 'exit.txt'), 'utf8').trim();
  assert.equal(exitCode, '3');
});
