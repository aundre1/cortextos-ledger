// Task commands: task:new, task:show, board (docs/cli.md "Tasks").

import {
  insertTask,
  getTask,
  listTasks,
  listRuns,
  listVerdicts,
  listTests,
  listEscalations,
} from '../ledger.mjs';

const VALID_ARMS = new Set(['tri', 'control']);
const VALID_KINDS = new Set(['implement', 'pr_review', 'research', 'ops']);
const OPEN_STATUSES = ['submitted', 'working', 'input_required'];

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

/** Number(value) with a NaN guard; returns { ok, value } so callers can bail cleanly. */
function toNumber(value) {
  if (value === undefined) return { ok: true, value: undefined };
  const n = Number(value);
  return { ok: !Number.isNaN(n), value: n };
}

function boardCompare(a, b) {
  const aInputRequired = a.status === 'input_required' ? 0 : 1;
  const bInputRequired = b.status === 'input_required' ? 0 : 1;
  if (aInputRequired !== bInputRequired) return aInputRequired - bInputRequired;
  const ap = a.priority ?? 3;
  const bp = b.priority ?? 3;
  if (ap !== bp) return ap - bp;
  const ad = a.due_at;
  const bd = b.due_at;
  if (ad === bd) return 0;
  if (ad == null) return 1;
  if (bd == null) return -1;
  return ad < bd ? -1 : 1;
}

export function register(registry) {
  registry.add('task:new', {
    description: 'Insert task, status submitted, print id',
    handler({ db, flags, err }) {
      const need = missing(flags, ['repo', 'title', 'class', 'arm']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      if (!VALID_ARMS.has(flags.arm)) {
        return fail(err, 1, 'usage', `--arm must be one of tri, control, got ${flags.arm}`);
      }
      if (flags.kind !== undefined && !VALID_KINDS.has(flags.kind)) {
        return fail(
          err,
          1,
          'usage',
          `--kind must be one of ${[...VALID_KINDS].join(', ')}, got ${flags.kind}`
        );
      }

      const issue = toNumber(flags.issue);
      const pr = toNumber(flags.pr);
      const priority = toNumber(flags.priority);
      if (!issue.ok) return fail(err, 1, 'usage', `--issue must be a number, got ${flags.issue}`);
      if (!pr.ok) return fail(err, 1, 'usage', `--pr must be a number, got ${flags.pr}`);
      if (!priority.ok) return fail(err, 1, 'usage', `--priority must be a number, got ${flags.priority}`);

      // Fable arbitration 2026-09-07 (after A): `sibling_id` is a real column
      // (src/schema/002-v01-columns.mjs) so src/measure.mjs can look up the
      // linked control/tri task directly. The `sibling=<id>` note from the
      // wave log's original OPEN QUESTION is kept alongside it for backward
      // compatibility with anything that only reads notes.
      const notes = flags.sibling ? `sibling=${flags.sibling}` : undefined;

      const task = insertTask(db, {
        repo: flags.repo,
        title: flags.title,
        task_class: flags.class,
        arm: flags.arm,
        issue_number: issue.value,
        pr_number: pr.value,
        kind: flags.kind,
        base_commit: flags.base,
        branch: flags.branch,
        worktree: flags.worktree,
        owner: flags.owner,
        priority: priority.value,
        due_at: flags.due,
        parent_id: flags.parent,
        sibling_id: flags.sibling,
        notes,
      });
      return { code: 0, stdout: task.id };
    },
  });

  registry.add('task:show', {
    description: 'Task, runs, verdicts, tests, escalations',
    handler({ db, args, flags, err }) {
      const id = args[0];
      if (!id) return fail(err, 1, 'usage', 'task:show requires a task id');
      const task = getTask(db, id);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${id}`);

      const runs = listRuns(db, id);
      const verdicts = listVerdicts(db, id);
      const tests = listTests(db, id);
      const escalations = listEscalations(db, id);

      if (flags.json) {
        return { code: 0, stdout: JSON.stringify({ task, runs, verdicts, tests, escalations }) };
      }

      const lines = [];
      lines.push(`task ${task.id}  [${task.status}]  ${task.title}`);
      lines.push(`  repo ${task.repo}  class ${task.task_class}  arm ${task.arm}  kind ${task.kind}`);
      lines.push(`  owner ${task.owner ?? '-'}  priority ${task.priority}  due ${task.due_at ?? '-'}`);
      if (task.outcome) lines.push(`  outcome ${task.outcome}`);
      if (task.notes) lines.push(`  notes ${task.notes}`);
      lines.push(`  runs (${runs.length}):`);
      for (const r of runs) lines.push(`    ${r.id}  seq ${r.seq}  ${r.agent}  ${r.status ?? 'running'}`);
      lines.push(`  verdicts (${verdicts.length}):`);
      for (const v of verdicts) {
        lines.push(`    ${v.id}  ${v.reviewer}  ${v.decision}  challenge_seq ${v.challenge_seq}`);
      }
      lines.push(`  tests (${tests.length}):`);
      for (const t of tests) lines.push(`    ${t.id}  ${t.suite}  ${t.status}`);
      lines.push(`  escalations (${escalations.length}):`);
      for (const e of escalations) lines.push(`    ${e.id}  ${e.reason}  ${e.severity ?? '-'}`);
      return { code: 0, stdout: lines.join('\n') };
    },
  });

  registry.add('board', {
    description: 'Table of open tasks, input_required first',
    handler({ db, flags }) {
      let tasks;
      if (flags.status) {
        tasks = listTasks(db, { status: flags.status, owner: flags.owner });
      } else {
        tasks = listTasks(db, { owner: flags.owner }).filter((t) => OPEN_STATUSES.includes(t.status));
      }
      tasks = [...tasks].sort(boardCompare);

      if (flags.json) return { code: 0, stdout: JSON.stringify(tasks) };
      if (!tasks.length) return { code: 0, stdout: 'no tasks' };
      const lines = tasks.map(
        (t) =>
          `${t.status.padEnd(15)} p${t.priority}  ${t.id}  ${(t.due_at ?? '-').padEnd(24)} ${t.owner ?? '-'}  ${t.title}`
      );
      return { code: 0, stdout: lines.join('\n') };
    },
  });
}
