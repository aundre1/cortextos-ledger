// Task commands: task:new, task:show, board (docs/cli.md "Tasks").
//
// task:new's PR capture (task E1-1, docs/review-protocol.md "PR triage
// mode"): `--kind pr_review --repo owner/name --pr <n>` shells out to `gh`
// (argv, shell: false - docs/security.md "Credential boundary") to fetch the
// PR's metadata and diff before the task row is ever inserted, so a `gh`
// failure never leaves a half-populated task (requirement 6 on this task
// card) - see capturePr()/runGh() below.
//
// Review round 2 (F4/F6, blind adversarial reviewer against the real CLI and
// a real stub `gh`): the diff is written to a temp path under
// `<runs>/.tmp/` (created alongside, and covered by, the same `.cortex/`
// gitignore/publish-check rule that already excludes the whole runs root -
// docs/security.md "Never committed") and streamed straight to disk from
// `gh pr diff`'s stdout - never buffered in memory (spawnSync's `maxBuffer`
// only applies to piped output; here stdout goes straight to an open file
// descriptor, so a 70 MB diff is exactly as safe as a 5 MB one - F6). The
// ledger transaction that inserts the task/artifact/brief rows runs entirely
// against that temp file (with the artifact row's sha256/bytes precomputed
// from it and passed straight to insertArtifact, since the final path does
// not exist on disk yet); only after a successful commit is `<runs>/<task
// id>/` created and the temp file renamed into place. A transaction failure
// (FOREIGN KEY constraint, or anything else) deletes the temp file and never
// creates the task directory - F4.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { withImmediateTransaction, newId, nowIso } from '../db.mjs';
import {
  insertTask,
  insertMessage,
  insertArtifact,
  insertIntervention,
  getTask,
  listTasks,
  listRuns,
  listVerdicts,
  listTests,
  listEscalations,
} from '../ledger.mjs';
import { filterEnv, redact } from '../adapters/credential-boundary.mjs';
import { applyResolvedCommand, resolveConfiguredCommand } from '../adapters/resolve-command.mjs';
import { sweepTmpDir, writePidSidecar, removePidSidecar } from '../tmp-sweep.mjs';

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
 *
 * Only used for `gh pr view`'s small JSON payload - review round 2, F6: the
 * diff itself no longer goes through a buffered spawnSync call at all (see
 * runGhDiffToFile below), because spawnSync's `maxBuffer` applies to piped
 * output regardless of how high it is set, and a 70 MB diff piped through
 * Node exceeded even this function's old 64 MiB ceiling on some platforms
 * (ENOBUFS) well before the 2,000,000 byte size guard ever got a chance to
 * apply.
 *
 * `opts.toolOverride` (`config.tools.gh`, docs/adapters.md "Windows command
 * resolution") skips PATH resolution entirely when set; otherwise `gh` is
 * resolved via `resolveConfiguredCommand` - on POSIX this is still exactly
 * the plain `spawnSync('gh', ...)` PATH search this comment used to
 * describe, unchanged; on win32 it finds the real `gh.exe` behind a
 * `gh.cmd` shim (or uses `gh.exe` directly when that is what is on PATH -
 * the reference Windows machine's `gh` is a real `.exe`, so this is a no-op
 * there today, but the resolution runs the same way regardless of what a
 * given operator's PATH happens to contain).
 */
function runGh(args, opts = {}) {
  const resolution = resolveConfiguredCommand('gh', { toolOverride: opts.toolOverride });
  const { cmd, args: finalArgs } = applyResolvedCommand(resolution, args);
  let result;
  try {
    result = spawnSync(cmd, finalArgs, {
      shell: false,
      encoding: 'utf8',
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
 * `gh pr diff <n> --repo <r>`, with stdout streamed straight to a file
 * descriptor opened on `destPath` instead of through spawnSync's own pipe
 * buffering (review round 2, F6). This is the fix for the 70 MB diff
 * repro: `stdio: ['ignore', <fd>, 'pipe']` means Node never buffers stdout
 * in memory at all - the kernel copies bytes straight from gh's pipe to the
 * destination file - so `maxBuffer` (which only bounds a *piped* stream)
 * never comes into play for the diff, only for stderr, which stays small.
 * Same return shape as runGh: `{ ok: true }` or `{ ok: false, code, reason,
 * detail }`. Never throws.
 */
function runGhDiffToFile(args, destPath, opts = {}) {
  let fd;
  try {
    fd = openSync(destPath, 'w');
  } catch (e) {
    return { ok: false, code: 1, reason: 'gh_failed', detail: `could not open ${destPath}: ${e.message}` };
  }
  const resolution = resolveConfiguredCommand('gh', { toolOverride: opts.toolOverride });
  const { cmd, args: finalArgs } = applyResolvedCommand(resolution, args);
  let result;
  try {
    result = spawnSync(cmd, finalArgs, {
      shell: false,
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
      env: filterEnv(process.env, {}),
    });
  } catch (e) {
    return { ok: false, code: 1, reason: 'gh_missing', detail: e.message };
  } finally {
    closeSync(fd);
  }
  if (result.error) {
    const isMissing = result.error.code === 'ENOENT';
    return {
      ok: false,
      code: 1,
      reason: isMissing ? 'gh_missing' : 'gh_failed',
      detail: result.error.message,
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim() || `gh exited ${result.status}`;
    return { ok: false, code: 1, reason: 'gh_failed', detail: `gh ${args.join(' ')}: ${detail}` };
  }
  return { ok: true };
}

/**
 * Copies `srcPath` to `destPath`, redacting (src/adapters/credential-
 * boundary.mjs `redact()`) one line at a time - the same at-rest approach
 * src/adapters/runner.mjs uses for out.txt. A streaming read (createReadStream,
 * decoded as utf8 so a multi-byte character split across a chunk boundary
 * is reassembled correctly rather than mangled) means the whole diff is
 * never held in memory at once (review round 2, F6 - no whole-file
 * readFileSync). Lines are split/rejoined on '\n' exactly as the source had
 * them, including a source that does not end in a trailing newline, so a
 * diff needing no redaction round-trips byte for byte. Returns a Promise
 * that resolves once `destPath` is fully written, or rejects on any read/
 * write error.
 */
function redactFileToFile(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    const input = createReadStream(srcPath, { encoding: 'utf8' });
    const output = createWriteStream(destPath);
    let buffer = '';
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      input.destroy();
      output.destroy();
      reject(e);
    };
    input.on('error', fail);
    output.on('error', fail);
    input.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) output.write(`${redact(line)}\n`);
    });
    input.on('end', () => {
      if (buffer.length) output.write(redact(buffer));
      output.end();
    });
    output.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}

/** sha256 of a file via a streaming read (no readFileSync - review round 2, F6 applies here too, since this runs on the same potentially-70MB file). Byte size is measured separately via fs.statSync, not by accumulating chunk lengths or Buffer.byteLength on a string. */
function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * `gh pr view <n> --repo <r> --json ...` then streams `gh pr diff <n> --repo
 * <r>` straight to `tmpRawDiffPath` (docs/review-protocol.md). Never throws;
 * propagates runGh's/runGhDiffToFile's `{ ok: false, code, reason, detail }`
 * on either call's failure - "gh missing", "gh not authenticated", and "PR
 * not found" all come back this way, distinguished only by gh's own stderr
 * text in `detail` (this task card's four failure modes do not get four
 * different reason codes: gh's own error text already says which one
 * happened, and hand-parsing that text to re-derive a reason would be
 * brittle across gh versions). `meta.baseRefOid`/`meta.headRefOid`/etc. may
 * be `undefined` rather than crash when gh's JSON omits a field (e.g. a PR
 * with no computed merge base yet) - every read of `meta` downstream uses
 * `?.` for exactly this reason.
 */
function capturePr(repo, pr, tmpRawDiffPath, opts = {}) {
  const view = runGh(
    ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,title,body,baseRefOid,headRefOid,baseRefName,headRefName'],
    opts
  );
  if (!view.ok) return view;

  let meta;
  try {
    meta = JSON.parse(view.stdout);
  } catch (e) {
    return { ok: false, code: 1, reason: 'gh_failed', detail: `gh pr view returned invalid JSON: ${e.message}` };
  }

  const diff = runGhDiffToFile(['pr', 'diff', String(pr), '--repo', repo], tmpRawDiffPath, opts);
  if (!diff.ok) return diff;

  return { ok: true, meta };
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
    async handler({ db, config, flags, err }) {
      // Blind review NF3: sweep any stale <runs>/.tmp/ leftovers at the
      // start of every task:new (not only a PR-capture one - a stale entry
      // could equally be a previous call's own PR-capture temp file, so
      // every task:new pays this small readdir-and-stat cost, not only the
      // ones that will create their own new temp file below).
      sweepTmpDir(config.runs);

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
      //
      // Review round 2, F4: the task id is generated up front (as before -
      // needed to name the temp diff files below), but nothing lands under
      // `<runs>/<taskId>/` until after the ledger transaction near the
      // bottom of this branch commits. Everything before that point only
      // ever touches `<runs>/.tmp/` - a sibling of every task's run
      // directory, created here and cleaned up on any failure path, so a
      // `gh` failure or a transaction failure (e.g. FOREIGN KEY from a bad
      // --parent) never leaves an orphaned task directory or temp file
      // behind. `<runs>/.tmp/` sits under the same runs root that
      // docs/security.md's "Never committed" table and this repo's
      // .gitignore already exclude wholesale via `.cortex/` (config.runs
      // defaults to `./.cortex/runs`), so no separate ignore rule is
      // needed for it.
      let capture = null;
      let taskId;
      let tmpDir;
      let tmpRawDiffPath;
      let tmpRedactedDiffPath;
      let redactedTitle;
      let redactedBody;
      let diffPath;
      let diffSha256;
      let diffBytes;
      if (flags.kind === 'pr_review' && pr.value !== undefined) {
        taskId = newId('t');
        tmpDir = join(config.runs, '.tmp');
        mkdirSync(tmpDir, { recursive: true });
        tmpRawDiffPath = join(tmpDir, `${taskId}.pr.diff.raw`);

        // Blind review NF5: write the pid sidecar the instant the raw
        // file's path is decided - before anything ever opens it for
        // writing (capturePr, just below, is what actually opens it) - so a
        // concurrent init/task:new's sweep (src/tmp-sweep.mjs) can never
        // observe this file without also seeing proof that this process is
        // still alive and still writing it, no matter how slow the `gh pr
        // diff` that follows turns out to be.
        writePidSidecar(tmpRawDiffPath);

        // Blind review NF3(b): the raw temp diff must never survive this
        // call, on ANY exit path - gh failing, a throw during redaction or
        // hashing (disk full, permissions, anything), or the ordinary
        // success path that used to unlink it inline partway through. A
        // `finally` around the whole capture (rather than a cleanup snippet
        // duplicated at each individual failure point, as before) is what
        // makes that true regardless of which path is taken; relying only
        // on the next `init`/`task:new` sweep (src/tmp-sweep.mjs) to catch a
        // leftover eventually would still leave an unredacted diff sitting
        // on disk for up to that sweep's 60 minute age threshold. The pid
        // sidecar written above is removed here too (NF5), in the same
        // `finally`, so it never outlives the raw file it guards.
        try {
          const captured = capturePr(flags.repo, pr.value, tmpRawDiffPath, { toolOverride: config.tools?.gh });
          if (!captured.ok) {
            return fail(err, captured.code, captured.reason, captured.detail);
          }
          capture = captured;

          redactedTitle = redact(capture.meta?.title ?? '');
          redactedBody = redact(capture.meta?.body ?? '');

          // Review round 2, F6: redact the raw temp diff to a second temp
          // file line by line via a streaming read (never a whole-file
          // readFileSync - the raw file can be 70+ MB), reusing the exact
          // same redact() src/adapters/runner.mjs applies to out.txt.
          tmpRedactedDiffPath = join(tmpDir, `${taskId}.pr.diff`);
          await redactFileToFile(tmpRawDiffPath, tmpRedactedDiffPath);

          // fs.statSync (not Buffer.byteLength on a string - the diff is no
          // longer ever held as one in-memory string) measures the size
          // guard against the file that will actually become pr.diff; the
          // sha256 for the artifact row is computed with its own streaming
          // read.
          diffBytes = statSync(tmpRedactedDiffPath).size;
          diffSha256 = await hashFile(tmpRedactedDiffPath);
          if (diffBytes > MAX_DIFF_BYTES) {
            // Requirement 7: still write it in full, never truncate - only
            // note it, on the task and on stderr.
            notesParts.push(`pr_diff_oversized:${diffBytes}`);
            err(
              `cortexctl: warning: pr diff for ${flags.repo}#${pr.value} is ${diffBytes} bytes, ` +
                `over the ${MAX_DIFF_BYTES} byte guard; written in full to pr.diff`
            );
          }

          // The final path the artifact row and the reviewer brief will
          // name. It does not exist on disk yet - see the rename after the
          // transaction below (F4) - so insertArtifact is given the
          // sha256/bytes already computed from the temp file instead of
          // trying (and failing) to stat a path that isn't there yet.
          diffPath = join(config.runs, taskId, 'pr.diff');
        } finally {
          try {
            if (existsSync(tmpRawDiffPath)) unlinkSync(tmpRawDiffPath);
          } catch {
            // best effort - a failed cleanup must not mask the real error
            // (or, on the success path, the result already returned).
          }
          removePidSidecar(tmpRawDiffPath);
        }
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
        base_sha: capture ? capture.meta?.baseRefOid : undefined,
        head_sha: capture ? capture.meta?.headRefOid : undefined,
        kind: flags.kind,
        // For a captured PR, default base_commit/branch from the PR's own
        // base/head shas and head branch name when the operator did not
        // pass --base/--branch explicitly - the columns already exist for
        // exactly this purpose (docs/review-protocol.md's reviewer brief
        // reads task.base_commit/branch) and an explicit flag always wins.
        // `meta.baseRefOid`/`meta.headRefName` may be missing from gh's own
        // JSON (e.g. no computed merge base yet); `?.` here plus
        // insertTask's own nullish() means that stores a plain null rather
        // than throwing a TypeError.
        base_commit: flags.base ?? (capture ? capture.meta?.baseRefOid : undefined),
        branch: flags.branch ?? (capture ? capture.meta?.headRefName : undefined),
        worktree: flags.worktree,
        owner: flags.owner,
        priority: priority.value,
        due_at: flags.due,
        parent_id: flags.parent,
        sibling_id: flags.sibling,
        notes,
      };

      // Requirement 6 (and review round 2, F4): with a PR capture, the task
      // row, its brief message, and its diff artifact row are inserted
      // together inside one BEGIN IMMEDIATE transaction (src/db.mjs
      // withImmediateTransaction) - a failure partway through (a bad
      // --parent's FOREIGN KEY violation, for instance) rolls every one of
      // those inserts back. This transaction only ever touches `db`, never
      // the run directory - the temp redacted diff file is only renamed
      // into `<runs>/<taskId>/pr.diff` after a successful commit, below, so
      // a rolled-back transaction leaves nothing on disk but the temp file,
      // which the catch here deletes. Without a capture this is a single
      // insertTask call, unchanged from before this task.
      let task;
      try {
        task = capture
          ? withImmediateTransaction(db, () => {
              const inserted = insertTask(db, taskFields);
              insertArtifact(db, {
                task_id: inserted.id,
                kind: 'pr_review',
                path: diffPath,
                sha256: diffSha256,
                bytes: diffBytes,
              });
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
      } catch (e) {
        if (capture) {
          try {
            unlinkSync(tmpRedactedDiffPath);
          } catch {
            // best effort - the original transaction error is what matters
          }
        }
        throw e;
      }

      // Only after a successful commit does anything land under
      // `<runs>/<taskId>/` (F4) - create the task's run directory now and
      // atomically rename the fully redacted temp file into place.
      // fs.renameSync is atomic because both paths share the runs root's
      // volume (never os.tmpdir(), which can be a different filesystem -
      // Windows-safe rename requires staying on one volume).
      if (capture) {
        mkdirSync(join(config.runs, taskId), { recursive: true });
        renameSync(tmpRedactedDiffPath, diffPath);
      }

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
      // Blocker 2: task:show always shows an archived task and says so
      // plainly (docs/state-machine.md "Archive, never delete") - archiving
      // never removes anything from what this command reports.
      if (task.archived_at) {
        lines.push(
          `  ARCHIVED at ${task.archived_at}${task.archive_reason ? `: ${task.archive_reason}` : ''}`
        );
      }
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
    description: 'Table of open tasks, input_required first (archived tasks excluded - see task:archive)',
    handler({ db, flags }) {
      let tasks;
      if (flags.status) {
        tasks = listTasks(db, { status: flags.status, owner: flags.owner });
      } else {
        tasks = listTasks(db, { owner: flags.owner }).filter((t) => OPEN_STATUSES.includes(t.status));
      }
      // Blocker 2: an archived task is excluded from board exactly like an
      // unadjudicated task already is from report's statistics
      // (docs/measurement.md) - archiving does not change `status`, so this
      // filter is independent of the `--status` branch above.
      tasks = tasks.filter((t) => !t.archived_at);
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

  // Blocker 2 (owner's explicit instruction): the operator's actual need was
  // never "delete a task" - it was "set this aside, but never lose it".
  // `task:archive` records that decision on the task itself
  // (`tasks.archived_at`/`archive_reason`, migration 009-v02-archive.mjs)
  // and in the ledger (a `human_interventions` row of kind `archive`,
  // docs/ledger.md) - it never deletes a row, never changes `status`, and
  // never resolves an open escalation or kills a running process ("Archive
  // resolves nothing and kills nothing"). `board`/`compare`/`report` (this
  // file and src/measure.mjs) exclude an archived task exactly as they
  // already exclude an unadjudicated one; `task:show`/`export` are
  // unaffected - nothing about the record disappears.
  registry.add('task:archive', {
    description: 'Archive a task (excluded from board/compare/report; task:show and export are unaffected) - see task:unarchive, purge',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);

      // Archiving a task with a run still `running` is refused: exit code 6
      // (docs/state-machine.md "Task is in a state that does not allow the
      // command") - the same code every other invalid-state refusal in this
      // kit uses (e.g. run:start on a completed task, task:close's close
      // gate). Archive is metadata, not a kill switch - a running run must
      // finish (or be halted by a guard, or a human) on its own first.
      const runningCount = db
        .prepare("SELECT COUNT(*) AS c FROM task_runs WHERE task_id = ? AND status = 'running'")
        .get(task.id).c;
      if (runningCount > 0) {
        return fail(
          err,
          6,
          'task_state',
          `task ${task.id} has ${runningCount} run(s) still running; cannot archive until they finish (archive resolves nothing and kills nothing)`
        );
      }

      const reason = flags.reason ?? null;
      withImmediateTransaction(db, () => {
        db.prepare('UPDATE tasks SET archived_at = ?, archive_reason = ? WHERE id = ?').run(
          nowIso(),
          reason,
          task.id
        );
        insertIntervention(db, { task_id: task.id, kind: 'archive', detail: reason });
      });
      return { code: 0, stdout: 'ok' };
    },
  });

  registry.add('task:unarchive', {
    description: 'Restore an archived task to board/compare/report',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);

      db.prepare('UPDATE tasks SET archived_at = NULL, archive_reason = NULL WHERE id = ?').run(task.id);
      return { code: 0, stdout: 'ok' };
    },
  });
}
