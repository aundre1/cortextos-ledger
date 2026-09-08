// Codex round, F1 (blocker): src/adapters/spawn.mjs's launchDetached built
// its child's environment as `{ ...process.env, ...argv.env }`. Every real
// adapter's buildArgv already returns a COMPLETE environment via
// credential-boundary.mjs's `filterEnv(process.env, ...)` - filterEnv copies
// every key except the ones its rules strip, so a key argv.env omits was
// deliberately removed, not "not yet decided". Spreading process.env again
// as the base, with argv.env only overlaid on top, silently restored every
// omitted key from the base layer (an omitted key in the override never
// clears anything the base already has) - so ANTHROPIC_API_KEY,
// CORTEX_PROXY_*, and (for the claude adapter) OPENAI_API_KEY all reached
// the harness whenever this process's own environment happened to carry
// them, exactly defeating docs/security.md's credential boundary.
//
// This exercises the real, non-fake run:launch path end to end (same
// scaffolding as test/launch-real-path.test.mjs) with a stub harness that
// dumps every environment variable it actually received, and a deliberately
// poisoned calling environment - proving the boundary holds through the real
// spawn.mjs -> runner.mjs -> harness chain, not just at filterEnv() in
// isolation (credential-boundary.test.mjs already covers filterEnv alone;
// F1 escaped that suite precisely because the leak was one call site later).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_PATH = join(HERE, 'fixtures', 'stub-env-dump.mjs');

function makeConfig(dir, adapterName) {
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
      adapters: {
        [adapterName]: { cmd: process.execPath, argsPrefix: [STUB_PATH] },
      },
    })
  );
  return configPath;
}

async function waitForDoneMarker(outDir, timeoutMs = 8000) {
  const donePath = join(outDir, 'done.marker');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(donePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return existsSync(donePath);
}

const CASES = [
  {
    adapter: 'codex',
    model: 'gpt-stub',
    poison: { ANTHROPIC_API_KEY: 'sk-ant-poison-codex', CORTEX_PROXY_TOKEN: 'proxy-poison-codex' },
    mustNotSurvive: ['ANTHROPIC_API_KEY', 'CORTEX_PROXY_TOKEN'],
  },
  {
    // Rule 2: the claude adapter additionally strips OPENAI_/NVIDIA_/etc.
    adapter: 'claude',
    model: 'claude-stub',
    poison: { ANTHROPIC_API_KEY: 'sk-ant-poison-claude', OPENAI_API_KEY: 'sk-poison-claude' },
    mustNotSurvive: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  },
];

for (const { adapter, model, poison, mustNotSurvive } of CASES) {
  test(`run:launch (${adapter}, real spawn path): a poisoned ${Object.keys(poison).join('/')} in the calling process never reaches the harness (F1)`, async () => {
    const homeDir = makeTempDir();
    const { dir: worktree, baseCommit } = makeTempGitRepo();
    const configPath = makeConfig(homeDir, adapter);
    const dumpPath = join(homeDir, 'env-dump.json');
    const env = { ...process.env, ...poison, CORTEX_TEST_ENV_DUMP_PATH: dumpPath };
    const cli = (args) => runCli(['--config', configPath, ...args], { env });

    assert.equal(cli(['init']).code, 0);
    const newTask = cli([
      'task:new', '--repo', 'o/n', '--title', `spawn-env ${adapter}`, '--class', 'ci', '--arm', 'control',
      '--worktree', worktree, '--base', baseCommit,
    ]);
    assert.equal(newTask.code, 0, newTask.stderr);
    const taskId = newTask.stdout.trim();

    const promptPath = join(homeDir, 'prompt.txt');
    writeFileSync(promptPath, `do the thing as ${adapter}`);

    const launch = cli([
      'run:launch', '--task', taskId, '--agent', 'builder', '--adapter', adapter,
      '--provider', adapter, '--model', model, '--prompt-file', promptPath,
    ]);
    assert.equal(launch.code, 0, launch.stderr);

    const outDir = join(homeDir, 'runs', taskId, 'builder');
    const done = await waitForDoneMarker(outDir);
    assert.ok(done, `done.marker never appeared in ${outDir} within the timeout`);

    assert.ok(existsSync(dumpPath), 'stub should have dumped its received environment');
    const harnessEnv = JSON.parse(readFileSync(dumpPath, 'utf8'));
    for (const key of mustNotSurvive) {
      assert.equal(
        harnessEnv[key],
        undefined,
        `${key} leaked into the ${adapter} harness's real environment: ${JSON.stringify(harnessEnv[key])}`
      );
    }
    // Sanity: the harness did receive *an* environment, not an empty one -
    // proves the fix (using argv.env as-is) didn't just wipe everything out.
    assert.ok(Object.keys(harnessEnv).length > 5, 'harness environment should not be empty');
  });
}
