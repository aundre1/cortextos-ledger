// End to end scenario through the CLI only (docs/architecture.md "Data
// flow"), with the fake adapter and a temp git repo: control arm through
// close, tri arm through blind review/adjudication/close, then compare,
// packet, doctor, export against the same task pair. Every step goes
// through `runCli` (a real `node bin/cortexctl.mjs` child process) rather
// than calling src/*.mjs directly, so this exercises argv parsing, exit
// codes, and stdout/stderr exactly as an operator would see them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, makeTempGitRepo, makeTempDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Setup, matching test/runs.test.mjs's pattern: config/db/fixtures live
// under a separate homeDir, never inside the git worktree, so the
// files_touched guard's `git ls-files --others` never picks up the kit's
// own scratch files as if the agent had touched them.
// ---------------------------------------------------------------------------

function makeConfig(dir) {
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
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function setup() {
  const homeDir = makeTempDir();
  const { dir, baseCommit } = makeTempGitRepo();
  const configPath = makeConfig(homeDir);
  return { homeDir, dir, baseCommit, configPath, env: { ...process.env } };
}

function cli(args, ctx, envOverride) {
  return runCli(['--config', ctx.configPath, ...args], { env: envOverride ?? ctx.env });
}

// Fixture files named here land in the run's own out_dir (the runtime
// layout in docs/architecture.md: `<runs>/<task-id>/<agent>/patch.diff` etc,
// never the worktree); anything else in `fixture.files` is a relative path
// under the worktree, simulating the agent's real code change there.
const OUT_DIR_FILES = new Set(['patch.diff', 'reasoning.md', 'verdict.json']);

function launchWithFixture(ctx, taskId, agent, fixture, extraFlags = []) {
  const outDir = join(ctx.homeDir, 'runs', taskId, agent);
  const resolved = { ...fixture };
  if (fixture.files) {
    resolved.files = Object.fromEntries(
      Object.entries(fixture.files).map(([key, value]) =>
        OUT_DIR_FILES.has(key) ? [join(outDir, key), value] : [key, value]
      )
    );
  }
  const fixturePath = join(ctx.homeDir, `fixture-${agent}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixturePath, JSON.stringify(resolved));
  const promptPath = join(ctx.homeDir, `prompt-${agent}.txt`);
  writeFileSync(promptPath, `do the thing as ${agent}`);
  const result = cli(
    [
      'run:launch', '--task', taskId, '--agent', agent, '--provider', 'fake', '--model', 'fake-model',
      '--adapter', 'fake', '--prompt-file', promptPath, ...extraFlags,
    ],
    ctx,
    { ...ctx.env, CORTEX_FAKE_FIXTURE: fixturePath }
  );
  return { result, outDir };
}

// A message event with cost/tokens, so `ingest` has something to roll into
// cost_usage (docs/adapters.md "Normalized event format").
function buildEvents() {
  return [
    { ts: '2026-09-07T01:00:00.000Z', type: 'session.start', session_id: 's1', agent: 'builder', model: 'fake-model' },
    { ts: '2026-09-07T01:00:01.000Z', type: 'tool.call', tool: 'write', args_summary: 'path=src/x.mjs' },
    { ts: '2026-09-07T01:00:01.500Z', type: 'tool.result', tool: 'write', ok: true },
    {
      ts: '2026-09-07T01:00:02.000Z', type: 'message', role: 'assistant',
      tokens_in: 500, tokens_out: 200, cost_usd: 0.0123, text: 'implemented the fix',
    },
    { ts: '2026-09-07T01:00:03.000Z', type: 'session.end', exit_code: 0, tokens_in: 500, tokens_out: 200, cost_usd: 0.0123, requests: 1 },
  ];
}

function validVerdict() {
  return {
    verdict_version: '1',
    decision: 'changes_requested',
    summary: 'The fix works but has an unguarded edge case that will throw on empty input.',
    findings: [
      {
        id: 'F1',
        severity: 'major',
        file: 'src/tri-feature.mjs',
        line: 1,
        claim: 'No guard for an empty input array before indexing it.',
        evidence: '+export function feature(xs) { return xs[0]; }',
        suggested_fix: 'Return null (or throw a clear error) when xs.length === 0.',
      },
    ],
    tests_touched: false,
    tests_touched_justified: null,
    scope_exceeded: false,
    confidence: 0.7,
  };
}

// One arm through run:launch -> run:end -> ingest -> test, returning the
// run id so the caller can thread it into whatever comes next.
function runBuilderSteps(ctx, taskId, agent, fileName) {
  const { result: launch, outDir } = launchWithFixture(ctx, taskId, agent, {
    exitCode: 0,
    events: buildEvents(),
    files: {
      [fileName]: `export function feature(xs) { return xs[0]; }\n`,
      'patch.diff': `diff --git a/${fileName} b/${fileName}\n+export function feature(xs) { return xs[0]; }\n`,
      'reasoning.md': `# Reasoning\n\nImplemented the fix directly, no edge cases considered here.\n`,
    },
  });
  assert.equal(launch.code, 0, `run:launch (${agent}) stderr: ${launch.stderr}`);
  const runId = launch.stdout.trim();
  assert.match(runId, /^r_/);

  const end = cli(['run:end', '--run', runId], ctx);
  assert.equal(end.code, 0, end.stderr);
  assert.equal(end.stdout.trim(), 'ok', `run:end (${agent}) stdout: ${end.stdout} stderr: ${end.stderr}`);

  const ingest = cli(
    ['ingest', '--events', join(outDir, 'events.jsonl'), '--task', taskId, '--run', runId],
    ctx
  );
  assert.equal(ingest.code, 0, ingest.stderr);

  const testResult = cli(
    ['test', '--task', taskId, '--suite', 'unit', '--status', 'pass', '--passed', '5', '--failed', '0'],
    ctx
  );
  assert.equal(testResult.code, 0, testResult.stderr);

  return { runId, outDir };
}

test('e2e: control arm and tri arm through the CLI, compare, packet, doctor, export', () => {
  const ctx = setup();

  // ---- init -----------------------------------------------------------
  const init = cli(['init'], ctx);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /schema version:/);

  // ---- control arm ------------------------------------------------------
  const controlNew = cli(
    ['task:new', '--repo', 'o/n', '--title', 'Fix the off-by-one', '--class', 'ci',
     '--arm', 'control', '--issue', '42', '--worktree', ctx.dir, '--base', ctx.baseCommit],
    ctx
  );
  assert.equal(controlNew.code, 0, controlNew.stderr);
  const controlId = controlNew.stdout.trim();
  assert.match(controlId, /^t_/);

  const controlPreflight = cli(['preflight', '--worktree', ctx.dir, '--provider', 'fake'], ctx);
  assert.equal(controlPreflight.code, 0, controlPreflight.stderr);
  assert.equal(controlPreflight.stdout.trim(), 'ok');

  runBuilderSteps(ctx, controlId, 'solo', 'src/control-feature.mjs');

  const controlClose = cli(['task:close', '--task', controlId, '--outcome', 'first_pass'], ctx);
  assert.equal(controlClose.code, 0, controlClose.stderr);

  const controlShow = JSON.parse(cli(['task:show', controlId, '--json'], ctx).stdout);
  assert.equal(controlShow.task.status, 'completed');
  assert.equal(controlShow.task.outcome, 'first_pass');

  // ---- tri arm ------------------------------------------------------
  const triNew = cli(
    ['task:new', '--repo', 'o/n', '--title', 'Fix the off-by-one', '--class', 'ci',
     '--arm', 'tri', '--issue', '42', '--worktree', ctx.dir, '--base', ctx.baseCommit,
     '--sibling', controlId],
    ctx
  );
  assert.equal(triNew.code, 0, triNew.stderr);
  const triId = triNew.stdout.trim();
  assert.match(triId, /^t_/);

  const triPreflight = cli(['preflight', '--worktree', ctx.dir, '--provider', 'fake'], ctx);
  assert.equal(triPreflight.code, 0, triPreflight.stderr);

  const brief = cli(
    ['msg', '--task', triId, '--kind', 'brief', '--from', 'architect', '--to', 'builder', '--body', 'Fix the off-by-one in feature()'],
    ctx
  );
  assert.equal(brief.code, 0, brief.stderr);

  runBuilderSteps(ctx, triId, 'builder', 'src/tri-feature.mjs');

  // ---- blind review -----------------------------------------------------
  const reviewBrief = cli(['review:brief', '--task', triId, '--reviewer', 'reviewer'], ctx);
  assert.equal(reviewBrief.code, 0, reviewBrief.stderr);
  const briefPath = reviewBrief.stdout.trim();
  assert.ok(existsSync(briefPath), `reviewer brief not written to ${briefPath}`);
  const briefText = readFileSync(briefPath, 'utf8');
  assert.match(briefText, /# Diff/);
  assert.doesNotMatch(briefText, /Reasoning\n\nImplemented the fix/, 'reviewer brief must never include the builder reasoning text');

  const verdictObj = validVerdict();
  const { result: reviewerLaunch, outDir: reviewerOutDir } = launchWithFixture(ctx, triId, 'reviewer', {
    exitCode: 0,
    events: [{ ts: '2026-09-07T01:05:00.000Z', type: 'session.start', session_id: 'rev1' }],
    files: { 'verdict.json': JSON.stringify(verdictObj) },
  });
  assert.equal(reviewerLaunch.code, 0, reviewerLaunch.stderr);
  const reviewerRunId = reviewerLaunch.stdout.trim();

  const reviewerEnd = cli(['run:end', '--run', reviewerRunId], ctx);
  assert.equal(reviewerEnd.code, 0, reviewerEnd.stderr);
  assert.equal(reviewerEnd.stdout.trim(), 'ok');

  const verdictPath = join(reviewerOutDir, 'verdict.json');
  const verdictCall = cli(
    ['verdict', '--task', triId, '--run', reviewerRunId, '--reviewer', 'reviewer',
     '--provider', 'fake', '--model', 'fake-reviewer-model', '--file', verdictPath],
    ctx
  );
  assert.equal(verdictCall.code, 0, verdictCall.stderr);
  assert.match(verdictCall.stdout.trim(), /^v_/);

  const triAdjudicate = cli(['adjudicate', '--task', triId, '--real', '1', '--noise', '0'], ctx);
  assert.equal(triAdjudicate.code, 0, triAdjudicate.stderr);
  assert.match(triAdjudicate.stdout.trim(), /^h_/);

  const triClose = cli(['task:close', '--task', triId, '--outcome', 'revised'], ctx);
  assert.equal(triClose.code, 0, triClose.stderr);
  assert.match(triClose.stdout, /compare hint/);

  // ---- compare: unadjudicated until the control arm is adjudicated too --
  const compareBefore = cli(['compare', '--task', triId, '--json'], ctx);
  assert.equal(compareBefore.code, 0, compareBefore.stderr);
  const compareBeforeJson = JSON.parse(compareBefore.stdout);
  assert.equal(compareBeforeJson.reading, 'unadjudicated', 'control arm has not been adjudicated yet');

  const controlAdjudicate = cli(
    ['adjudicate', '--task', controlId, '--real', '0', '--noise', '0', '--escaped', '1'],
    ctx
  );
  assert.equal(controlAdjudicate.code, 0, controlAdjudicate.stderr);

  const compareAfter = cli(['compare', '--task', triId, '--json'], ctx);
  assert.equal(compareAfter.code, 0, compareAfter.stderr);
  const compareAfterJson = JSON.parse(compareAfter.stdout);
  assert.notEqual(compareAfterJson.reading, 'unadjudicated');
  assert.ok(compareAfterJson.tri, 'compare output must include the tri arm bundle');
  assert.ok(compareAfterJson.control, 'compare output must include the control arm bundle');
  assert.equal(compareAfterJson.tri.arm, 'tri');
  assert.equal(compareAfterJson.control.arm, 'control');
  assert.equal(compareAfterJson.control.defects_escaped, 1);

  const compareHuman = cli(['compare', '--task', triId], ctx);
  assert.equal(compareHuman.code, 0, compareHuman.stderr);
  assert.notEqual(compareHuman.stdout.trim(), 'unadjudicated');
  assert.match(compareHuman.stdout, /escaped defects/);

  // ---- packet -------------------------------------------------------
  const packetDir = join(ctx.homeDir, 'packet-out');
  const packet = cli(['packet', '--task', triId, '--out', packetDir, '--json'], ctx);
  assert.equal(packet.code, 0, packet.stderr);
  const packetJsonPath = join(packetDir, 'packet.json');
  const packetMdPath = join(packetDir, 'packet.md');
  assert.ok(existsSync(packetJsonPath), 'packet.json was not written');
  assert.ok(existsSync(packetMdPath), 'packet.md was not written');
  const packetContent = JSON.parse(readFileSync(packetJsonPath, 'utf8'));
  assert.ok(packetContent.next_action, 'packet.json must carry next_action');
  assert.ok(packetContent.next_action.actor, 'next_action must name an actor');

  // ---- doctor -------------------------------------------------------
  const doctor = cli(['doctor', '--task', triId], ctx);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /next_action/);

  // ---- export -------------------------------------------------------
  const exportDir = join(ctx.homeDir, 'export-out');
  const exportResult = cli(['export', '--format', 'csv', '--out', exportDir], ctx);
  assert.equal(exportResult.code, 0, exportResult.stderr);
  const exportedFiles = readdirSync(exportDir).sort();
  const EXPECTED_TABLES = [
    'agent_messages', 'artifacts', 'cost_usage', 'escalations', 'human_interventions',
    'provider_quota', 'review_verdicts', 'task_runs', 'tasks', 'test_results', 'usage_snapshots',
  ];
  assert.deepEqual(exportedFiles, EXPECTED_TABLES.map((t) => `${t}.csv`).sort(), 'export must write exactly one file per table');
  const tasksCsv = readFileSync(join(exportDir, 'tasks.csv'), 'utf8');
  assert.match(tasksCsv, new RegExp(triId));
  assert.match(tasksCsv, new RegExp(controlId));
});
