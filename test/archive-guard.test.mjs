// Real Phase 1a defect and its fix: a driver read `export --table tasks`,
// found an ARCHIVED task for the repo/PR/arm it was looking for, and
// launched into it. `run:launch` happened to refuse (exit 6, `task_state`,
// "N open halt escalation(s)") only because that particular archived task
// also carried halt escalations - an archived task with none would have
// silently accepted the run. Archiving must mean nothing new attaches to a
// task, independent of escalations (docs/state-machine.md "Archive, never
// delete").
//
// FIX 1: every command that would add to or advance a task refuses first on
// `checkNotArchived` (src/limits.mjs) with exit 6, reason `archived`, and
// works again after `task:unarchive`.
// FIX 2: `task:find` is the supported lookup path instead of parsing
// `export` and filtering `archived_at` by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli, makeTempDb, makeTempDir, makeTempGitRepo } from './helpers.mjs';

function newTask(dbPath, extra = []) {
  const result = runCli([
    'task:new', '--db', dbPath,
    '--repo', 'owner/name', '--title', 'Guard me', '--class', 'archive-guard', '--arm', 'control',
    ...extra,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function archiveTask(dbPath, id, reason = 'set aside for archive-guard tests') {
  const result = runCli(['task:archive', '--db', dbPath, '--task', id, '--reason', reason]);
  assert.equal(result.code, 0, result.stderr);
}

function unarchiveTask(dbPath, id) {
  const result = runCli(['task:unarchive', '--db', dbPath, '--task', id]);
  assert.equal(result.code, 0, result.stderr);
}

/** exit 6, reason `archived` - never the generic task_state a real halt escalation would also produce. */
function assertArchivedRefusal(result) {
  assert.equal(result.code, 6, result.stderr);
  assert.match(result.stderr, /: archived:/, `expected reason "archived" in stderr, got: ${result.stderr}`);
}

// ---------------------------------------------------------------------------
// The real defect, reproduced exactly
// ---------------------------------------------------------------------------

test('real defect repro: run:launch on an archived task with NO open escalations refuses with reason archived, not task_state (before this fix it would have exited 0)', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id, 'connectivity test, superseded');

  // Confirm the premise: this task carries zero escalations - the real
  // Phase 1a task happened to have halt escalations, which is exactly what
  // masked this defect there (run:launch refused for the escalations, not
  // for being archived).
  const shown = JSON.parse(runCli(['task:show', id, '--db', dbPath, '--json']).stdout);
  assert.equal(shown.escalations.length, 0, 'premise: this task has no escalations');

  const launched = runCli([
    'run:launch', '--db', dbPath, '--task', id, '--agent', 'builder',
    '--prompt-file', join(makeTempDir(), 'unread-prompt.md'),
  ]);
  assertArchivedRefusal(launched);
  assert.doesNotMatch(launched.stderr, /task_state/, 'must not fall back to the generic task_state reason');

  // Nothing attached: still zero runs on this task.
  const after = JSON.parse(runCli(['task:show', id, '--db', dbPath, '--json']).stdout);
  assert.equal(after.runs.length, 0);
});

test('run:launch on an archived task WITH open halt escalations still refuses with reason archived (not task_state, even though task_state would also be true)', () => {
  // A real worktree so run:end's files_touched guard has something valid to
  // git-diff, and so the run can be ended (status != 'running') before
  // task:archive - task:archive itself refuses while a run is still
  // running, which is orthogonal to this fix.
  const { dir, baseCommit } = makeTempGitRepo();
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath, ['--worktree', dir, '--base', baseCommit]);

  // builder_attempts_max defaults to 3; force it to 1 for this task's
  // config so a second run:start trips retry_limit immediately.
  const configPath = join(makeTempDir(), 'cortex-ledger.json');
  writeFileSync(configPath, JSON.stringify({ db: dbPath, runs: join(makeTempDir(), 'runs'), limits: { builder_attempts_max: 1 } }));

  const first = runCli(['run:start', '--config', configPath, '--task', id, '--agent', 'builder', '--adapter', 'fake', '--provider', 'fake', '--model', 'fake-model']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(runCli(['run:end', '--config', configPath, '--run', first.stdout.trim()]).code, 0);

  const second = runCli(['run:start', '--config', configPath, '--task', id, '--agent', 'builder', '--adapter', 'fake', '--provider', 'fake', '--model', 'fake-model']);
  assert.equal(second.code, 3, second.stderr);
  assert.match(second.stderr, /retry_limit/);

  const shownBefore = JSON.parse(runCli(['task:show', id, '--db', dbPath, '--json']).stdout);
  assert.ok(shownBefore.escalations.some((e) => e.reason === 'retry_limit'), 'premise: this task DOES have a halt escalation');

  archiveTask(dbPath, id);

  const launched = runCli([
    'run:launch', '--config', configPath, '--task', id, '--agent', 'builder',
    '--prompt-file', join(makeTempDir(), 'unread-prompt.md'),
  ]);
  assertArchivedRefusal(launched);
});

// ---------------------------------------------------------------------------
// Every FIX 1 command: refuses archived, works again after unarchive
// ---------------------------------------------------------------------------

test('run:start on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const startArgs = ['run:start', '--db', dbPath, '--task', id, '--agent', 'builder', '--adapter', 'fake', '--provider', 'fake', '--model', 'fake-model', '--no-preflight'];
  assertArchivedRefusal(runCli(startArgs));

  unarchiveTask(dbPath, id);
  const started = runCli(startArgs);
  assert.equal(started.code, 0, started.stderr);
});

test('msg on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const msgArgs = ['msg', '--db', dbPath, '--task', id, '--kind', 'note', '--from', 'architect', '--to', 'human', '--body', 'hello'];
  assertArchivedRefusal(runCli(msgArgs));

  unarchiveTask(dbPath, id);
  assert.equal(runCli(msgArgs).code, 0);
});

test('artifact on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  const filePath = join(makeTempDir(), 'a.txt');
  writeFileSync(filePath, 'hi');
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const artifactArgs = ['artifact', '--db', dbPath, '--task', id, '--kind', 'note', '--path', filePath];
  assertArchivedRefusal(runCli(artifactArgs));

  unarchiveTask(dbPath, id);
  assert.equal(runCli(artifactArgs).code, 0);
});

test('test (record a suite) on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const testArgs = ['test', '--db', dbPath, '--task', id, '--suite', 'unit', '--status', 'pass'];
  assertArchivedRefusal(runCli(testArgs));

  unarchiveTask(dbPath, id);
  assert.equal(runCli(testArgs).code, 0);
});

test('intervene on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const interveneArgs = ['intervene', '--db', dbPath, '--task', id, '--kind', 'note', '--detail', 'x'];
  assertArchivedRefusal(runCli(interveneArgs));

  unarchiveTask(dbPath, id);
  assert.equal(runCli(interveneArgs).code, 0);
});

test('task:close on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath, ['--kind', 'research']); // skip implement's test-results close gate
  archiveTask(dbPath, id);

  const closeArgs = ['task:close', '--db', dbPath, '--task', id, '--outcome', 'first_pass'];
  assertArchivedRefusal(runCli(closeArgs));

  unarchiveTask(dbPath, id);
  const closed = runCli(closeArgs);
  assert.equal(closed.code, 0, closed.stderr);
});

test('task:resolve on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const resolveArgs = ['task:resolve', '--db', dbPath, '--task', id, '--note', 'x'];
  assertArchivedRefusal(runCli(resolveArgs));

  unarchiveTask(dbPath, id);
  const resolved = runCli(resolveArgs);
  assert.equal(resolved.code, 0, resolved.stderr);
});

test('task:reject on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const rejectArgs = ['task:reject', '--db', dbPath, '--task', id, '--note', 'x'];
  assertArchivedRefusal(runCli(rejectArgs));

  unarchiveTask(dbPath, id);
  const rejected = runCli(rejectArgs);
  assert.equal(rejected.code, 0, rejected.stderr);
});

test('review:brief on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const briefArgs = ['review:brief', '--db', dbPath, '--task', id, '--reviewer', 'reviewer'];
  assertArchivedRefusal(runCli(briefArgs));

  unarchiveTask(dbPath, id);
  const brief = runCli(briefArgs);
  assert.equal(brief.code, 0, brief.stderr);
});

test('verdict on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  const verdictPath = join(makeTempDir(), 'verdict.json');
  writeFileSync(verdictPath, JSON.stringify({
    verdict_version: '1',
    decision: 'approve',
    summary: 'ok',
    findings: [],
    tests_touched: false,
    tests_touched_justified: null,
    scope_exceeded: false,
    confidence: 0.9,
  }));
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const verdictArgs = ['verdict', '--db', dbPath, '--task', id, '--run', 'r_doesnotexist', '--reviewer', 'reviewer', '--provider', 'p', '--model', 'm', '--file', verdictPath];
  assertArchivedRefusal(runCli(verdictArgs));

  const beforeUnarchive = JSON.parse(runCli(['task:show', id, '--db', dbPath, '--json']).stdout);
  assert.equal(beforeUnarchive.verdicts.length, 0, 'the refused verdict must not have been stored');

  unarchiveTask(dbPath, id);
  const verdict = runCli(verdictArgs);
  assert.equal(verdict.code, 0, verdict.stderr);
});

test('adjudicate on an archived task refuses exit 6 reason archived; works again after task:unarchive', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id);

  const adjudicateArgs = ['adjudicate', '--db', dbPath, '--task', id, '--real', '1', '--noise', '0'];
  assertArchivedRefusal(runCli(adjudicateArgs));

  unarchiveTask(dbPath, id);
  const adjudicated = runCli(adjudicateArgs);
  assert.equal(adjudicated.code, 0, adjudicated.stderr);
});

test('task:new --sibling naming an archived task refuses exit 6 reason archived', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const archivedId = newTask(dbPath);
  archiveTask(dbPath, archivedId);

  const refused = runCli([
    'task:new', '--db', dbPath, '--repo', 'owner/name', '--title', 'new sibling', '--class', 'archive-guard', '--arm', 'tri',
    '--sibling', archivedId,
  ]);
  assertArchivedRefusal(refused);

  // ...and works once the sibling is unarchived.
  unarchiveTask(dbPath, archivedId);
  const ok = runCli([
    'task:new', '--db', dbPath, '--repo', 'owner/name', '--title', 'new sibling', '--class', 'archive-guard', '--arm', 'tri',
    '--sibling', archivedId,
  ]);
  assert.equal(ok.code, 0, ok.stderr);
});

test('task:new --parent naming an archived task refuses exit 6 reason archived', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const archivedId = newTask(dbPath);
  archiveTask(dbPath, archivedId);

  const refused = runCli([
    'task:new', '--db', dbPath, '--repo', 'owner/name', '--title', 'new child', '--class', 'archive-guard', '--arm', 'control',
    '--parent', archivedId,
  ]);
  assertArchivedRefusal(refused);
});

test('archiving/unarchiving a task never disturbs its own row or another task\'s ability to run', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const untouched = newTask(dbPath);
  const other = newTask(dbPath);
  archiveTask(dbPath, other);

  // The untouched sibling task is entirely unaffected.
  const started = runCli(['run:start', '--db', dbPath, '--task', untouched, '--agent', 'builder', '--adapter', 'fake', '--provider', 'fake', '--model', 'fake-model', '--no-preflight']);
  assert.equal(started.code, 0, started.stderr);
});

// ---------------------------------------------------------------------------
// task:show, export, board stay unaffected (already covered by
// test/archive.test.mjs; re-asserted narrowly here for this file's own
// read-only-commands claim)
// ---------------------------------------------------------------------------

test('task:show on an archived task still succeeds and prints the archived task in full - the retrieval path stays open', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  archiveTask(dbPath, id, 'kept for FIX 1 read-only claim');

  const shown = runCli(['task:show', id, '--db', dbPath]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /ARCHIVED/);
});

// ---------------------------------------------------------------------------
// FIX 2: task:find
// ---------------------------------------------------------------------------

test('task:find matches by --repo/--pr/--arm/--kind/--class, excludes archived by default, includes with --include-archived, exits 0 empty on no match', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);

  const created = runCli([
    'task:new', '--db', dbPath, '--repo', 'aundre1/cortextos-ledger', '--title', 'PR 1002 arm control',
    '--class', 'pr-triage', '--arm', 'control', '--kind', 'implement', '--pr', '1002',
  ]);
  assert.equal(created.code, 0, created.stderr);
  const id = created.stdout.trim();

  const byRepo = runCli(['task:find', '--db', dbPath, '--repo', 'aundre1/cortextos-ledger']);
  assert.equal(byRepo.code, 0, byRepo.stderr);
  assert.equal(byRepo.stdout.trim(), id);

  const byPr = runCli(['task:find', '--db', dbPath, '--repo', 'aundre1/cortextos-ledger', '--pr', '1002']);
  assert.equal(byPr.stdout.trim(), id);

  const byArm = runCli(['task:find', '--db', dbPath, '--arm', 'control']);
  assert.match(byArm.stdout, new RegExp(id));

  const byKind = runCli(['task:find', '--db', dbPath, '--kind', 'implement']);
  assert.match(byKind.stdout, new RegExp(id));

  const byClass = runCli(['task:find', '--db', dbPath, '--class', 'pr-triage']);
  assert.match(byClass.stdout, new RegExp(id));

  // No match at all: empty stdout, exit 0 - never an error.
  const noMatch = runCli(['task:find', '--db', dbPath, '--repo', 'nobody/nothing']);
  assert.equal(noMatch.code, 0, noMatch.stderr);
  assert.equal(noMatch.stdout.trim(), '');

  // Combining a wrong filter with a right one excludes it too.
  const wrongArm = runCli(['task:find', '--db', dbPath, '--repo', 'aundre1/cortextos-ledger', '--arm', 'tri']);
  assert.equal(wrongArm.stdout.trim(), '');

  // Excluded once archived (this is the exact lookup the real Phase 1a
  // driver should have used instead of parsing export).
  archiveTask(dbPath, id);
  const excluded = runCli(['task:find', '--db', dbPath, '--repo', 'aundre1/cortextos-ledger', '--pr', '1002']);
  assert.equal(excluded.code, 0, excluded.stderr);
  assert.equal(excluded.stdout.trim(), '');

  // ...but still visible with --include-archived, alongside export.
  const included = runCli(['task:find', '--db', dbPath, '--repo', 'aundre1/cortextos-ledger', '--pr', '1002', '--include-archived']);
  assert.equal(included.code, 0, included.stderr);
  assert.equal(included.stdout.trim(), id);
});

test('task:find with no filters at all lists every non-archived task id', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const a = newTask(dbPath);
  const b = newTask(dbPath);
  archiveTask(dbPath, b);

  const all = runCli(['task:find', '--db', dbPath]);
  assert.equal(all.code, 0, all.stderr);
  const ids = all.stdout.trim().split('\n').filter(Boolean);
  assert.ok(ids.includes(a));
  assert.ok(!ids.includes(b));
});
