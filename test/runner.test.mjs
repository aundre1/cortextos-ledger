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

// D1 (opencode's credentials.forwarded/credentials.missing bookkeeping):
// events already known before the harness spawns are seeded into
// eventsPath right after this run's own fresh-per-run truncation, ahead of
// anything the harness's own stdout produces.
test('runner: --initial-events seeds events.jsonl before the child\'s own events, surviving the fresh-per-run truncation', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();
  const eventsPath = join(outDir, 'events.jsonl');
  const seeded = [{ ts: '2026-01-01T00:00:00.000Z', type: 'credentials.forwarded', severity: 'info', providers: ['opencode-go'] }];

  const result = runRunner([
    '--out', outDir,
    '--cwd', cwd,
    '--adapter', 'fake',
    '--events', eventsPath,
    '--initial-events', JSON.stringify(seeded),
    '--',
    process.execPath, '-e', `console.log(${JSON.stringify(JSON.stringify({ ts: new Date().toISOString(), type: 'session.start', session_id: 's1' }))})`,
  ]);
  assert.equal(result.status, 0, result.stderr);

  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'credentials.forwarded');
  assert.deepEqual(lines[0].providers, ['opencode-go']);
  assert.ok(lines.some((e) => e.type === 'session.start'), 'the child-produced event should still be there too');
});

test('runner: malformed --initial-events is ignored rather than breaking the launch', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();

  const result = runRunner([
    '--out', outDir,
    '--cwd', cwd,
    '--initial-events', 'not json',
    '--',
    process.execPath, '-e', 'process.exit(0);',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(outDir, 'done.marker')));
});

// ---------------------------------------------------------------------------
// Regression: the final on-disk session.end line must carry the real
// exit_code and elapsed_ms, for every adapter. Before this fix, once ANY
// adapter's own createStreamParser() had reported a session.end at all
// (mid-stream, via push() - true for all three real adapters, not just
// opencode's synthesized end-of-stream one), this runner treated
// `sawSessionEnd` as "nothing more to do" and never patched in the real
// values it alone knows (the watchdog reads exit.txt for exit; measurement
// reads elapsed time). None of the three adapters' own raw harness output
// reports both fields correctly on its own: opencode's raw-stream fallback
// reports both as null on purpose; codex's `turn.completed` session.end
// reports neither; claude's final `result` line reports a real exit_code
// but calls the field `duration_ms`, never `elapsed_ms`.
// ---------------------------------------------------------------------------

function lastSessionEnd(eventsPath) {
  const lines = readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const ends = lines.filter((e) => e.type === 'session.end');
  return ends[ends.length - 1];
}

function runStubHarness({ adapterName, script, exitCode }) {
  const outDir = makeTempDir();
  const cwd = makeTempDir();
  const eventsPath = join(outDir, 'events.jsonl');
  const result = runRunner([
    '--out', outDir,
    '--cwd', cwd,
    '--adapter', adapterName,
    '--events', eventsPath,
    '--',
    process.execPath, '-e', `${script}\nsetTimeout(() => process.exit(${exitCode}), 30);`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const realExit = Number(readFileSync(join(outDir, 'exit.txt'), 'utf8').trim());
  const realElapsed = Number(readFileSync(join(outDir, 'elapsed_ms.txt'), 'utf8').trim());
  return { end: lastSessionEnd(eventsPath), realExit, realElapsed };
}

test('runner: opencode - the raw stream\'s null exit_code/elapsed_ms on session.end are patched with the real values', () => {
  const script = [
    `console.log(${JSON.stringify(JSON.stringify({ type: 'step_start', sessionID: 'ses_runner_test' }))});`,
    `console.log(${JSON.stringify(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_runner_test',
        part: { type: 'step-finish', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
      })
    )});`,
  ].join('\n');

  const { end, realExit, realElapsed } = runStubHarness({ adapterName: 'opencode', script, exitCode: 5 });
  assert.ok(end, 'events.jsonl should contain a session.end line');
  assert.equal(end.exit_code, 5);
  assert.equal(end.exit_code, realExit);
  assert.equal(typeof end.elapsed_ms, 'number');
  assert.ok(end.elapsed_ms >= 0);
  // The corrected line still carries whatever the original one reported.
  assert.equal(end.tokens_in, 10);
  assert.equal(end.session_id, 'ses_runner_test');
  void realElapsed;
});

test('runner: codex - turn.completed\'s session.end (missing exit_code and elapsed_ms entirely) is patched with the real values', () => {
  const script = [
    `console.log(${JSON.stringify(JSON.stringify({ type: 'thread.started', thread_id: 'th_runner_test' }))});`,
    `console.log(${JSON.stringify(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 8 } })
    )});`,
  ].join('\n');

  const { end, realExit } = runStubHarness({ adapterName: 'codex', script, exitCode: 3 });
  assert.ok(end, 'events.jsonl should contain a session.end line');
  assert.equal(end.exit_code, 3);
  assert.equal(end.exit_code, realExit);
  assert.equal(typeof end.elapsed_ms, 'number');
  assert.ok(end.elapsed_ms >= 0);
  assert.equal(end.tokens_in, 20);
  assert.equal(end.usage_source, 'reported');
});

test('runner: claude - the final result line reports a real exit_code but only "duration_ms", never "elapsed_ms" - patched onto the on-disk line', () => {
  const script = [
    `console.log(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess_runner_test' }))});`,
    `console.log(${JSON.stringify(
      JSON.stringify({
        type: 'result',
        session_id: 'sess_runner_test',
        is_error: false,
        usage: { input_tokens: 7, output_tokens: 2 },
        total_cost_usd: 0.001,
        num_turns: 1,
        duration_ms: 999,
      })
    )});`,
  ].join('\n');

  // is_error: false -> claude.mjs's own session.end already reports
  // exit_code 0, which happens to already agree with the real spawned
  // process's exit code below - only elapsed_ms is genuinely missing.
  const { end, realExit } = runStubHarness({ adapterName: 'claude', script, exitCode: 0 });
  assert.ok(end, 'events.jsonl should contain a session.end line');
  assert.equal(end.exit_code, 0);
  assert.equal(end.exit_code, realExit);
  assert.equal(typeof end.elapsed_ms, 'number');
  assert.ok(end.elapsed_ms >= 0);
  assert.equal(end.duration_ms, 999, 'the harness\'s own duration_ms is untouched');
  assert.equal(end.tokens_in, 7);
});

test('runner: normal completion (no pre-existing exit.txt) still writes the real exit code', () => {
  const outDir = makeTempDir();
  const cwd = makeTempDir();

  const result = runRunner(['--out', outDir, '--cwd', cwd, '--', process.execPath, '-e', 'process.exit(3);']);
  assert.equal(result.status, 0, result.stderr);

  const exitCode = readFileSync(join(outDir, 'exit.txt'), 'utf8').trim();
  assert.equal(exitCode, '3');
});
