// Task commands: task:new, task:show, board (docs/cli.md "Tasks").
//
// task:new's PR capture (task E1-1, docs/review-protocol.md "PR triage
// mode"): `--kind pr_review --repo owner/name --pr <n>` shells out to `gh`
// (argv, shell: false - docs/security.md "Credential boundary") to fetch the
// PR's metadata and diff before the task row is ever inserted, so a `gh`
// failure never leaves a half-populated task (requirement 6 on this task
// card) - see capturePr()/runGh() below.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withImmediateTransaction, newId } from '../db.mjs';
import {
  insertTask,
  insertMessage,
  insertArtifact,
  getTask,
  listTasks,
  listRuns,
  listVerdicts,
  listTests,
  listEscalations,
} from '../ledger.mjs';
import { filterEnv, redact } from '../adapters/credential-boundary.mjs';

const VALID_ARMS = new Set(['tri', 'control']);
const VALID_KINDS = new Set(['implement', 'pr_review', 'research', 'ops']);
const OPEN_STATUSES = ['submitted', 'working', 'input_required'];

// docs/review-protocol.md "PR triage mode": "still write it but record a
// note on the task" past this many bytes (this task card's size guard).
const MAX_DIFF_BYTES = 2_000_000;

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

/**
 * Run one `gh` subcommand as an argv array (never a shell string - docs'
 * "Windows first" coding rule and this task card's requirement 2). `gh` is
 * resolved through PATH the same way every other adapter in this kit
 * resolves its own binary (`cmd: cmd ?? 'claude'` in src/adapters/claude.mjs
 * and siblings): Node's spawn, even with `shell: false`, already performs
 * PATHEXT-aware resolution on Windows, so the literal name `gh` finds
 * `gh.exe` there and the plain `gh` binary on POSIX without this module
 * knowing which platform it is on.
 *
 * Never throws. Returns `{ ok: true, stdout }` or `{ ok: false, code,
 * reason, detail }` - `code` is the exit code task:new should return.
 * docs/state-machine.md's exit code table has no dedicated code for "an
 * external tool the kit shells out to failed"; code 1 ("usage error, bad
 * arguments, missing config") is used here for gh missing, gh not
 * authenticated, PR not found, and any other non-zero gh exit alike,
 * matching the precedent already set by src/guards/preflight.mjs (code 1
 * for a missing environment prerequisite - there, node:sqlite) rather than
 * inventing a new code the docs do not define. See this task's OPEN
 * QUESTION in the wave log.
 */
function runGh(args) {
  let result;
  try {
    result = spawnSync('gh', args, {
      shell: false,
      encoding: 'utf8',
      // A `gh pr diff` on a large PR can exceed Node's default 1 MiB
      // maxBuffer long before this command's own 2,000,000 byte size guard
      // even gets a chance to apply - raised well past that guard so a big
      // diff is captured (and only then evaluated against the guard),
      // never silently cut short by spawnSync itself.
      maxBuffer: 64 * 1024 * 1024,
      env: filterEnv(process.env, {}),
    });
  } catch (e) {
    return { ok: false, code: 1, reason: 'gh_missing', detail: e.message };
  }
  if (result.error) {
    // ENOENT (gh not on PATH) surfaces here, not as a throw, from spawnSync.
    const isMissing = result.error.code === 'ENOENT';
    return {
      ok: false,
      code: 1,
      reason: isMissing ? 'gh_missing' : 'gh_failed',
      detail: result.error.message,
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `gh exited ${result.status}`;
    return { ok: false, code: 1, reason: 'gh_failed', detail: `gh ${args.join(' ')}: ${detail}` };
  }
  return { ok: true, stdout: result.stdout ?? '' };
}

/**
 * `gh pr view <n> --repo <r> --json ...` then `gh pr diff <n> --repo <r>`,
 * in that order (docs/review-protocol.md). Never throws; propagates runGh's
 * `{ ok: false, code, reason, detail }` on either call's failure - "gh
 * missing", "gh not authenticated", and "PR not found" all come back this
 * way, distinguished only by gh's own stderr text in `detail` (this task
 * card's four failure modes do not get four different reason codes: gh's
 * own error text already says which one happened, and hand-parsing that
 * text to re-derive a reason would be brittle across gh versions).
 */
function capturePr(repo, pr) {
  const view = runGh([
    'pr', 'view', String(pr),
    '--repo', repo,
    '--json', 'number,title,body,baseRefOid,headRefOid,baseRefName,headRefName',
  ]);
  if (!view.ok) return view;

  let meta;
  try {
    meta = JSON.parse(view.stdout);
  } catch (e) {
    return { ok: false, code: 1, reason: 'gh_failed', detail: `gh pr view returned invalid JSON: ${e.message}` };
  }

  const diff = runGh(['pr', 'diff', String(pr), '--repo', repo]);
  if (!diff.ok) return diff;

  return { ok: true, meta, diffText: diff.stdout };
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
    description:
      'Insert task, status submitted, print id (--kind pr_review --repo <r> --pr <n> also captures the PR via gh)',
    handler({ db, config, flags, err }) {
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
      const notesParts = [];
      if (flags.sibling) notesParts.push(`sibling=${flags.sibling}`);

      // PR capture (task E1-1, docs/review-protocol.md "PR triage mode"):
      // triggers only when both --kind pr_review and --pr are given (--repo
      // is already required for every task:new call above). `--kind
      // pr_review` with no --pr, or --pr with a different --kind, is left
      // exactly as it was before this task - a plain pr_number column set,
      // no gh capture - so existing callers are unaffected.
      let capture = null;
      if (flags.kind === 'pr_review' && pr.value !== undefined) {
        const captured = capturePr(flags.repo, pr.value);
        if (!captured.ok) {
          return fail(err, captured.code, captured.reason, captured.detail);
        }
        capture = captured;
      }

      let redactedTitle;
      let redactedBody;
      let redactedDiff;
      let taskId;
      let diffPath;
      if (capture) {
        redactedTitle = redact(capture.meta.title ?? '');
        redactedBody = redact(capture.meta.body ?? '');
        redactedDiff = redact(capture.diffText ?? '');
        const diffBytes = Buffer.byteLength(redactedDiff, 'utf8');
        if (diffBytes > MAX_DIFF_BYTES) {
          // Requirement 7: still write it in full, never truncate - only
          // note it, on the task and on stderr.
          notesParts.push(`pr_diff_oversized:${diffBytes}`);
          err(
            `cortexctl: warning: pr diff for ${flags.repo}#${pr.value} is ${diffBytes} bytes, ` +
              `over the ${MAX_DIFF_BYTES} byte guard; written in full to pr.diff`
          );
        }

        // The task id is generated up front (rather than left to
        // insertTask's default) so the run dir / pr.diff path can be built
        // before the task row exists, and so insertTask below can be given
        // that same id inside the transaction that also writes the brief
        // message and the diff artifact row.
        taskId = newId('t');
        const taskDir = join(config.runs, taskId);
        mkdirSync(taskDir, { recursive: true });
        diffPath = join(taskDir, 'pr.diff');
        // Requirement 6: this fs write happens before any database write,
        // so a disk failure here still leaves zero rows behind - nothing to
        // roll back.
        writeFileSync(diffPath, redactedDiff);
      }

      const notes = notesParts.length ? notesParts.join('; ') : undefined;

      const taskFields = {
        id: taskId,
        repo: flags.repo,
        title: flags.title,
        task_class: flags.class,
        arm: flags.arm,
        issue_number: issue.value,
        pr_number: pr.value,
        pr_repo: capture ? flags.repo : undefined,
        base_sha: capture ? capture.meta.baseRefOid : undefined,
        head_sha: capture ? capture.meta.headRefOid : undefined,
        kind: flags.kind,
        // For a captured PR, default base_commit/branch from the PR's own
        // base/head shas and head branch name when the operator did not
        // pass --base/--branch explicitly - the columns already exist for
        // exactly this purpose (docs/review-protocol.md's reviewer brief
        // reads task.base_commit/branch) and an explicit flag always wins.
        base_commit: flags.base ?? (capture ? capture.meta.baseRefOid : undefined),
        branch: flags.branch ?? (capture ? capture.meta.headRefName : undefined),
        worktree: flags.worktree,
        owner: flags.owner,
        priority: priority.value,
        due_at: flags.due,
        parent_id: flags.parent,
        sibling_id: flags.sibling,
        notes,
      };

      // Requirement 6: with a PR capture, the task row, its brief message,
      // and its diff artifact row are inserted together inside one
      // BEGIN IMMEDIATE transaction (src/db.mjs withImmediateTransaction) -
      // a failure partway through rolls every one of those inserts back, so
      // the ledger never shows a task with no brief or no artifact row.
      // Without a capture this is a single insertTask call, unchanged from
      // before this task.
      const task = capture
        ? withImmediateTransaction(db, () => {
            const inserted = insertTask(db, taskFields);
            insertArtifact(db, { task_id: inserted.id, kind: 'pr_review', path: diffPath });
            insertMessage(db, {
              task_id: inserted.id,
              sender: 'ledger',
              recipient: flags.owner ?? 'architect',
              kind: 'brief',
              body: `${redactedTitle}\n\n${redactedBody}`,
            });
            return inserted;
          })
        : insertTask(db, taskFields);

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
