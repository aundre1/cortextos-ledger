// Review round 1, F2 (blocker) and F3 (major): "one launch path" and
// "redaction at rest". Before this fix, run:launch for a real adapter
// (claude/codex/opencode) bypassed parseStream entirely - the runner just
// redirected the harness's raw stdout/stderr straight to a file descriptor,
// so events.jsonl was never written for any non-fake run and out.txt held
// whatever secrets the harness happened to print. This test exercises the
// real (non `--sync`) run:launch path end to end for all three real
// adapters, using a stub harness in place of the real CLI
// (`config.adapters.<name>.cmd`/`argsPrefix`), and checks: events.jsonl
// exists with session.start/session.end, ingest fills tokens/cost from it,
// and out.txt is redacted - the secret text never appears, `[REDACTED]`
// does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'fixtures');
const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';

function makeConfig(dir, adapterName, stubPath) {
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
      // Review round 1, F2 test harness: stand a stub in for the real CLI
      // without touching claude.mjs/codex.mjs/opencode.mjs's default
      // 'claude'/'codex'/'opencode' command names.
      adapters: {
        [adapterName]: { cmd: process.execPath, argsPrefix: [stubPath] },
      },
    })
  );
  return configPath;
}

/** Poll for done.marker - bounded, 50ms intervals, no fixed sleep otherwise. */
async function waitForDoneMarker(outDir, timeoutMs = 8000) {
  const donePath = join(outDir, 'done.marker');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(donePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return existsSync(donePath);
}

const ADAPTERS = [
  { name: 'claude', stub: 'stub-claude.mjs', model: 'claude-stub', expectCost: true },
  { name: 'codex', stub: 'stub-codex.mjs', model: 'gpt-stub', expectCost: false },
  { name: 'opencode', stub: 'stub-opencode.mjs', model: 'opencode/stub-model', expectCost: true },
];

for (const { name, stub, model, expectCost } of ADAPTERS) {
  test(`run:launch (${name}, real launch path): events.jsonl written live, ingest fills tokens/cost, out.txt redacted`, async () => {
    const homeDir = makeTempDir();
    const { dir: worktree, baseCommit } = makeTempGitRepo();
    const stubPath = join(FIXTURES_DIR, stub);
    const configPath = makeConfig(homeDir, name, stubPath);
    const env = { ...process.env };
    const cli = (args) => runCli(['--config', configPath, ...args], { env });

    assert.equal(cli(['init']).code, 0);
    const newTask = cli([
      'task:new', '--repo', 'o/n', '--title', `launch ${name}`, '--class', 'ci', '--arm', 'control',
      '--worktree', worktree, '--base', baseCommit,
    ]);
    assert.equal(newTask.code, 0, newTask.stderr);
    const taskId = newTask.stdout.trim();

    const promptPath = join(homeDir, 'prompt.txt');
    writeFileSync(promptPath, `do the thing as ${name}`);

    // No --sync: this is the default detached path every real adapter (and,
    // by default, fake too) now goes through - buildArgv + launchDetached +
    // runner.mjs's tee (F2/F3), not the old fd-redirect runner or an
    // in-process shortcut.
    const launch = cli([
      'run:launch', '--task', taskId, '--agent', 'builder', '--adapter', name,
      '--provider', name, '--model', model, '--prompt-file', promptPath,
    ]);
    assert.equal(launch.code, 0, launch.stderr);
    const runId = launch.stdout.trim();
    assert.match(runId, /^r_/);

    const outDir = join(homeDir, 'runs', taskId, 'builder');
    const done = await waitForDoneMarker(outDir);
    assert.ok(done, `done.marker never appeared in ${outDir} within the timeout`);

    // --- events.jsonl: written live by runner.mjs via the adapter's
    // createStreamParser(), not only ever for the fake adapter (F2). ---
    const eventsPath = join(outDir, 'events.jsonl');
    assert.ok(existsSync(eventsPath), 'events.jsonl should exist for a real adapter launch');
    const events = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.type === 'session.start'), 'events.jsonl should contain a session.start');
    assert.ok(events.some((e) => e.type === 'session.end'), 'events.jsonl should contain a session.end');

    // --- ingest: fills task_runs tokens and cost_usage cost from exactly
    // that file. ---
    const ingestResult = cli(['ingest', '--events', eventsPath, '--task', taskId, '--run', runId, '--json']);
    assert.equal(ingestResult.code, 0, ingestResult.stderr);
    const ingested = JSON.parse(ingestResult.stdout);
    assert.ok(ingested.tokens_in > 0, `expected tokens_in > 0, got ${ingested.tokens_in}`);
    assert.ok(ingested.tokens_out > 0, `expected tokens_out > 0, got ${ingested.tokens_out}`);
    if (expectCost) {
      assert.ok(ingested.cost_usd > 0, `expected cost_usd > 0, got ${ingested.cost_usd}`);
    }

    const taskShow = cli(['task:show', taskId, '--json']);
    assert.equal(taskShow.code, 0, taskShow.stderr);
    const view = JSON.parse(taskShow.stdout);
    const runRow = view.runs.find((r) => r.id === runId);
    assert.ok(runRow, 'run row should be present on task:show');
    assert.ok(runRow.tokens_in > 0, 'task_runs.tokens_in should be filled by ingest');
    if (expectCost) {
      assert.ok(runRow.cost_usd > 0, 'task_runs.cost_usd should be filled by ingest');
    }

    // --- out.txt: redacted at rest (F3), whatever the harness printed to
    // stderr. ---
    const outText = readFileSync(join(outDir, 'out.txt'), 'utf8');
    assert.ok(outText.includes('[REDACTED]'), `out.txt should contain [REDACTED]: ${outText}`);
    assert.equal(outText.includes(SECRET), false, `out.txt must never contain the raw secret: ${outText}`);
  });
}
