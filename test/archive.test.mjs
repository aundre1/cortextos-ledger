// Blocker 2 (owner's explicit instruction): work must be ARCHIVED for later
// retrieval, never deleted. task:archive/task:unarchive (src/commands/
// tasks.mjs, migration 009-v02-archive.mjs) and purge's new refusal
// (src/commands/setup.mjs) - docs/state-machine.md "Archive, never delete".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runCli, makeTempDb } from './helpers.mjs';

function newTask(dbPath, extra = []) {
  const result = runCli([
    'task:new', '--db', dbPath,
    '--repo', 'owner/name', '--title', 'Archive me', '--class', 'archive-tests', '--arm', 'control',
    ...extra,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('task:archive excludes a task from board; task:unarchive restores it', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);

  assert.match(runCli(['board', '--db', dbPath]).stdout, new RegExp(id));

  const archived = runCli(['task:archive', '--db', dbPath, '--task', id, '--reason', 'connectivity test, not part of the measured batch']);
  assert.equal(archived.code, 0, archived.stderr);

  const boardAfterArchive = runCli(['board', '--db', dbPath]);
  assert.equal(boardAfterArchive.stdout.includes(id), false, 'an archived task must not appear on board');

  const unarchived = runCli(['task:unarchive', '--db', dbPath, '--task', id]);
  assert.equal(unarchived.code, 0, unarchived.stderr);

  const boardAfterUnarchive = runCli(['board', '--db', dbPath]);
  assert.match(boardAfterUnarchive.stdout, new RegExp(id), 'task:unarchive should restore the task to board');
});

test('task:archive writes a human_interventions row of kind archive, and task:show still shows the task as archived', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);

  const reason = 'provider 429 storm before retry support, superseded';
  assert.equal(runCli(['task:archive', '--db', dbPath, '--task', id, '--reason', reason]).code, 0);

  const shown = runCli(['task:show', id, '--db', dbPath, '--json']);
  assert.equal(shown.code, 0, shown.stderr);
  const view = JSON.parse(shown.stdout);
  assert.ok(view.task.archived_at, 'task:show --json should carry archived_at');
  assert.equal(view.task.archive_reason, reason);

  const shownHuman = runCli(['task:show', id, '--db', dbPath]);
  assert.match(shownHuman.stdout, /ARCHIVED/);
  assert.match(shownHuman.stdout, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('archived task is not deleted from export - it still appears, with archived_at/archive_reason columns', () => {
  const dbPath = makeTempDb();
  const dir = dirname(dbPath);
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  assert.equal(runCli(['task:archive', '--db', dbPath, '--task', id, '--reason', 'x']).code, 0);

  const out = runCli(['export', '--db', dbPath, '--format', 'json', '--table', 'tasks', '--out', dir]);
  assert.equal(out.code, 0, out.stderr);
  const rows = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
  const row = rows.find((r) => r.id === id);
  assert.ok(row, 'export must still include an archived task - nothing lost from the record');
  assert.ok(row.archived_at, 'export row should carry archived_at');
  assert.equal(row.archive_reason, 'x');
});

test('archiving a task with a run still running is refused with exit 6 (docs/state-machine.md "Task is in a state that does not allow the command")', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);

  // run:start never spawns anything (docs/cli.md) - this leaves task_runs in
  // status 'running' with nothing to ever call run:end, exactly the
  // condition task:archive must refuse against. --no-preflight skips the git
  // worktree check, which this task (created with no --worktree) has
  // nothing for anyway.
  const started = runCli(['run:start', '--db', dbPath, '--task', id, '--agent', 'builder', '--adapter', 'fake', '--provider', 'fake', '--model', 'fake-model', '--no-preflight']);
  assert.equal(started.code, 0, started.stderr);

  const archived = runCli(['task:archive', '--db', dbPath, '--task', id, '--reason', 'x']);
  assert.equal(archived.code, 6, archived.stderr);
  assert.match(archived.stderr, /task_state/);

  // Archive resolves nothing and kills nothing: the task is still exactly
  // as it was (not archived, run still running).
  const shown = JSON.parse(runCli(['task:show', id, '--db', dbPath, '--json']).stdout);
  assert.equal(shown.task.archived_at, null);
  assert.equal(shown.runs[0].status, 'running');
});

test('purge on a non-archived task is refused with exit 6; purge on an archived task still works', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);

  const refused = runCli(['purge', '--db', dbPath, '--task', id, '--confirm']);
  assert.equal(refused.code, 6, refused.stderr);
  assert.match(refused.stderr, /not_archived/);
  assert.match(refused.stderr, /task:archive/);

  // The task must still be there - purge's refusal did not delete anything.
  assert.equal(runCli(['task:show', id, '--db', dbPath, '--json']).code, 0);

  assert.equal(runCli(['task:archive', '--db', dbPath, '--task', id, '--reason', 'x']).code, 0);

  const purged = runCli(['purge', '--db', dbPath, '--task', id, '--confirm']);
  assert.equal(purged.code, 0, purged.stderr);
  assert.equal(runCli(['task:show', id, '--db', dbPath, '--json']).code, 1, 'the task should genuinely be gone after purge');
});

test('purge without --confirm names task:archive as the intended alternative on stderr', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const id = newTask(dbPath);
  const result = runCli(['purge', '--db', dbPath, '--task', id]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /IRREVERSIBLY DELETES/);
  assert.match(result.stderr, /task:archive/);
});

test('an archived task is excluded from compare (treated as no linked pair), and from report\'s per-class counts', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);

  const control = runCli([
    'task:new', '--db', dbPath, '--repo', 'o/n', '--title', 'control', '--class', 'archive-compare', '--arm', 'control',
  ]);
  assert.equal(control.code, 0, control.stderr);
  const controlId = control.stdout.trim();

  const tri = runCli([
    'task:new', '--db', dbPath, '--repo', 'o/n', '--title', 'tri', '--class', 'archive-compare', '--arm', 'tri',
    '--sibling', controlId,
  ]);
  assert.equal(tri.code, 0, tri.stderr);
  const triId = tri.stdout.trim();

  // Before archiving, compare finds the pair (unadjudicated, but a pair).
  const beforeCompare = runCli(['compare', '--db', dbPath, '--task', triId, '--json']);
  assert.equal(beforeCompare.code, 0, beforeCompare.stderr);
  assert.equal(JSON.parse(beforeCompare.stdout).ok, true);

  assert.equal(runCli(['task:archive', '--db', dbPath, '--task', controlId, '--reason', 'x']).code, 0);

  // compare's own handler (src/commands/measure.mjs) exits 1/not_found for
  // any unresolved pair, archived or otherwise - findSiblingPair (src/
  // measure.mjs) now treats an archived sibling exactly like a missing one,
  // so this is the same "no linked pair" refusal a genuinely unpaired task
  // already gets, not a distinct archived-specific shape.
  const afterCompare = runCli(['compare', '--db', dbPath, '--task', triId, '--json']);
  assert.equal(afterCompare.code, 1, 'compare must not find a pair once one arm is archived');
  assert.match(afterCompare.stderr, /not_found/);

  const report = runCli(['report', '--db', dbPath, '--class', 'archive-compare', '--json']);
  assert.equal(report.code, 0, report.stderr);
  const reportView = JSON.parse(report.stdout);
  const cls = reportView.classes.find((c) => c.task_class === 'archive-compare');
  // Only the tri task remains un-archived - report's count for this class
  // must reflect that, not the two tasks originally created.
  assert.ok(cls, 'the class should still appear (the tri task is not archived)');
  assert.equal(cls.count, 1);
});
