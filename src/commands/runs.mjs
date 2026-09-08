// Run and task-lifecycle commands (docs/cli.md "Runs" and part of "Tasks",
// "Tests and closing"): preflight, run:start, run:launch, run:end, watch,
// msg, artifact, test, intervene, task:close, task:resolve, task:reject.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nowIso, withImmediateTransaction } from '../db.mjs';
import {
  getTask,
  listTests,
  listEscalations,
  listVerdicts,
  insertRun,
  nextRunSeq,
  insertMessage,
  insertArtifact,
  insertTest,
  insertIntervention,
} from '../ledger.mjs';
import {
  checkAttempts,
  checkSpend,
  checkQuota,
  checkOpencodeSerial,
  checkNotArchived,
  transition,
  escalate,
  resolveEscalations,
  retroactiveWallclock,
  computeBackoffMs,
} from '../limits.mjs';
import { reserveRequest } from '../quota.mjs';
import { preflight as runPreflight } from '../guards/preflight.mjs';
import {
  filesTouched,
  testEditDetection,
  toolFailureStreak,
  scopeMarker,
  missingPatch,
  classifyFailureClass,
} from '../guards/postrun.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { launchDetached, pollPidFile, waitForDoneMarker } from '../adapters/spawn.mjs';
import { redact } from '../adapters/credential-boundary.mjs';
import { watch as watchRun } from '../guards/watchdog.mjs';
import { activeFor } from '../policy.mjs';
import { normalizeExitCode } from '../exit-code.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', '..', 'bin', 'cortexctl.mjs');

const START_ALLOWED_STATUSES = new Set(['submitted', 'working', 'input_required']);
const VALID_TEST_STATUS = new Set(['pass', 'fail', 'error', 'skipped']);
const VALID_INTERVENE_KINDS = new Set(['rescue', 'edit', 'approve', 'abort', 'note']);
const VALID_OUTCOMES = new Set(['first_pass', 'revised', 'failed', 'abandoned']);
const OUTCOME_TO_STATUS = {
  first_pass: 'completed',
  revised: 'completed',
  failed: 'failed',
  abandoned: 'canceled',
};

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

/**
 * Resolve adapter/provider/model for an agent: CLI flags, then the active
 * routing policy for the task's class (docs/autonomy.md "Policy proposals":
 * "run:start consults the active policy for the task's class before falling
 * back to config.agents"), then config.agents[agent], then fallbacks.
 */
function resolveAgentDefaults(db, config, taskClass, agentName, flags) {
  const policyOverrides = activeFor(db, taskClass)?.overrides ?? {};
  const agentConfig = { ...(config.agents?.[agentName] ?? {}), ...(policyOverrides[agentName] ?? {}) };
  return {
    adapterName: flags.adapter ?? agentConfig.adapter ?? 'fake',
    provider: flags.provider ?? agentConfig.provider ?? 'fake',
    model: flags.model ?? agentConfig.model ?? null,
  };
}

function openHaltEscalations(db, taskId) {
  return listEscalations(db, taskId).filter((e) => e.severity === 'halt' && !e.resolved_at);
}

// Halt reasons doRunStart's own ledger gates (checkLedgerGates) re-derive
// from scratch on every call - unlike files_touched, secrets, dirty_worktree
// or wallclock, a fresh run:start does not need a human to have resolved
// one of these first: it re-checks the same gate itself and, if the
// underlying condition has not changed, fails again with that gate's own
// specific reason (review round 1, F1 concurrency test: once the first
// over-limit call has escalated retry_limit and moved the task to
// input_required, every later call - racing or sequential - must still see
// retry_limit, not a generic task_state refusal that masks it).
const SELF_RECHECKED_HALT_REASONS = new Set(['retry_limit', 'budget', 'quota', 'opencode_serial']);

/** Open halts that block a *new* run:start outright - i.e. every open halt except one of doRunStart's own gates, which will simply re-fire with its own specific reason instead. */
function blockingOpenHalts(db, taskId) {
  return openHaltEscalations(db, taskId).filter((e) => !SELF_RECHECKED_HALT_REASONS.has(e.reason));
}

/**
 * The three ledger gates plus the opencode_serial dial, read only - shared
 * between doRunStart's fast advisory pass (before preflight's git/fs work,
 * so an obviously-refused call never pays for a `git status` spawn) and the
 * authoritative re-check inside `withImmediateTransaction` right before
 * `insertRun` (review round 1, F1). Returns the first gate that fails, or
 * `{ ok: true }`.
 */
function checkLedgerGates(db, config, { taskId, agent, provider, model, adapterName, isPublic }) {
  const attempts = checkAttempts(db, config, taskId, agent);
  if (!attempts.ok) return { ok: false, reason: 'retry_limit', attempts };

  const spend = checkSpend(db, config, taskId, agent, model);
  if (!spend.ok) return { ok: false, reason: 'budget', spend };

  const quota = checkQuota(db, config, provider, model, spend.projectedNext, { isPublic });
  if (!quota.ok) return { ok: false, reason: quota.reason, quota };

  const serial = checkOpencodeSerial(db, config, adapterName);
  if (!serial.ok) return { ok: false, reason: 'opencode_serial', serial };

  return { ok: true, spend };
}

/** Turn a failing checkLedgerGates() result into the { result: <fail> } doRunStart returns, writing the matching escalation. */
function failGate(err, db, taskId, gate) {
  if (gate.reason === 'retry_limit') {
    const escalation = escalate(db, {
      taskId,
      reason: 'retry_limit',
      severity: 'halt',
      detail: `${gate.attempts.used}/${gate.attempts.max} attempts used`,
    });
    return fail(err, 3, 'retry_limit', `${gate.attempts.used}/${gate.attempts.max} attempts used (escalation ${escalation.id})`);
  }
  if (gate.reason === 'budget') {
    const escalation = escalate(db, {
      taskId,
      reason: 'budget',
      severity: 'halt',
      detail: `projected $${gate.spend.projected.toFixed(4)} exceeds limit $${gate.spend.max}`,
    });
    return fail(err, 3, 'budget', `projected $${gate.spend.projected.toFixed(4)} exceeds limit $${gate.spend.max} (escalation ${escalation.id})`);
  }
  if (gate.reason === 'opencode_serial') {
    // Unlike the other gates, this is a transient host-wide condition, not
    // this task's problem - the other OpenCode run will finish on its own
    // and this same command can simply be retried, so (unlike retry_limit/
    // budget/quota) it does not write an escalation or move the task to
    // input_required (docs/adapters.md "Concurrency note").
    return fail(err, 6, 'opencode_serial', `${gate.serial.running} opencode run(s) already running on this host`);
  }
  // quota / public_only
  const escalation = escalate(db, {
    taskId,
    reason: 'quota',
    severity: 'halt',
    detail: gate.quota.detail ?? gate.quota.reason,
  });
  return fail(err, 4, gate.quota.reason, `${gate.quota.detail ?? gate.quota.reason} (escalation ${escalation.id})`);
}

/**
 * Shared body of run:start, reused by run:launch. On success returns
 * { result: {code:0, stdout: runId}, run, task, outDir, adapterName }; on
 * any gate failure returns { result: <the failing {code}> } only.
 *
 * Review round 1, F1: the whole check-attempts / check-spend / check-quota /
 * preflight-decision / insertRun / setTaskStatus sequence is atomic with
 * respect to every other `run:start` on the same db, not merely
 * individually consistent. Preflight's git and filesystem work (slow,
 * external, and identical regardless of what any concurrent caller is
 * doing) runs first, outside any transaction, as does a first advisory pass
 * of the ledger gates so an already-refused call fails fast without paying
 * for that work. Once preflight's pass/fail decision is in hand, a single
 * `BEGIN IMMEDIATE` transaction re-checks the same ledger gates - the
 * authoritative check, since the lock it holds serializes every concurrent
 * caller - and only then computes `seq` (MAX(seq)+1, not a COUNT that a
 * concurrent insert could make stale) and inserts the run, all before
 * releasing the lock. test/concurrency.test.mjs exercises this directly.
 *
 * `runStartOpts.checkCommandResolution` (default false): whether the
 * preflight call below is told which adapter this run needs, so it can
 * refuse (code 1, reason `command_not_found`) when that harness cannot be
 * found anywhere on PATH (docs/adapters.md "Windows command resolution").
 *
 * `run:start` never spawns anything itself - it only records admission (a
 * ledger row, a status transition) - so it must keep admitting a run even
 * on a host where the harness binary is not installed at all (a pure
 * ledger-admission test, or an orchestrator that provisions the harness
 * later, should not be blocked by this). `run:launch` (the one command that
 * actually spawns the harness right after admitting the run) passes
 * `checkCommandResolution: true` so a missing harness is caught before the
 * spawn ever happens; the standalone `preflight --adapter <x>` command
 * checks it unconditionally, independent of either. See docs/guards.md
 * "Command resolution" and docs/cli.md's `run:start`/`run:launch` rows.
 *
 * `ctx.platform`/`ctx.env` are test-only injection points (never set by the
 * real CLI dispatcher in bin/cortexctl.mjs, so they are always `undefined`
 * -> the real `process.platform`/`process.env` in production) forwarded
 * straight through to `preflight`'s own same-named, same-purpose opts -
 * see test/runs.test.mjs "command resolution: run:start admits, run:launch
 * refuses".
 */
async function doRunStart({ db, config, flags, err, platform, env }, runStartOpts = {}) {
  const { checkCommandResolution = false } = runStartOpts;
  const need = missing(flags, ['task', 'agent']);
  if (need.length) {
    return { result: fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`) };
  }

  const task = getTask(db, flags.task);
  if (!task) return { result: fail(err, 1, 'not_found', `no such task: ${flags.task}`) };

  // Real Phase 1a defect fix: archived, checked before every other state
  // check (docs/state-machine.md "Archive, never delete") - see
  // checkNotArchived's own doc comment (src/limits.mjs) for why this must
  // come first and why it is its own reason rather than task_state.
  const notArchived = checkNotArchived(task);
  if (!notArchived.ok) {
    return { result: fail(err, 6, 'archived', notArchived.detail) };
  }

  if (!START_ALLOWED_STATUSES.has(task.status)) {
    return {
      result: fail(err, 6, 'task_state', `task ${task.id} is ${task.status}, cannot start a run`),
    };
  }
  if (task.status === 'input_required') {
    const openHalts = blockingOpenHalts(db, task.id);
    if (openHalts.length > 0) {
      return {
        result: fail(
          err,
          6,
          'task_state',
          `task ${task.id} has ${openHalts.length} open halt escalation(s); resolve first`
        ),
      };
    }
  }

  const agent = flags.agent;
  const { adapterName, provider, model } = resolveAgentDefaults(db, config, task.task_class, agent, flags);
  if (!model) {
    return {
      result: fail(
        err,
        1,
        'usage',
        `no model resolved for agent ${agent}; pass --model or configure agents.${agent}.model`
      ),
    };
  }

  const isPublic = !!flags.public;
  const gateArgs = { taskId: task.id, agent, provider, model, adapterName, isPublic };

  // Advisory pass: fails fast, before preflight's git/fs work, in the exact
  // same reason-priority order run:start has always used (attempts, spend,
  // quota, opencode_serial). Under no concurrent writer this is also the
  // final word; under one, the re-check inside the transaction below is.
  const advisoryGate = checkLedgerGates(db, config, gateArgs);
  if (!advisoryGate.ok) {
    return { result: failGate(err, db, task.id, advisoryGate) };
  }

  let haltedReasonPreflight = null;
  if (!flags['no-preflight']) {
    const pf = await runPreflight(db, config, {
      worktree: task.worktree,
      provider,
      model,
      isPublic,
      allowDirty: !!flags['allow-dirty'],
      strict: !!flags.strict,
      taskId: task.id,
      // Only launch (which actually spawns the harness) tells preflight
      // which adapter this run needs - see doRunStart's doc comment above.
      adapterName: checkCommandResolution ? adapterName : null,
      platform,
      env,
    });
    if (!pf.ok) {
      return { result: fail(err, pf.code, pf.reason, pf.detail ?? '') };
    }
  } else {
    haltedReasonPreflight = 'preflight_skipped';
  }

  const outDir = join(config.runs, task.id, agent);
  const outcome = withImmediateTransaction(db, () => {
    const gate = checkLedgerGates(db, config, gateArgs);
    if (!gate.ok) return { ok: false, gate };

    const seq = nextRunSeq(db, task.id);
    const run = insertRun(db, {
      task_id: task.id,
      seq,
      agent,
      provider,
      model,
      adapter: adapterName,
      status: 'running',
      worktree: task.worktree,
      out_dir: outDir,
      wallclock_limit_s: config.limits.wallclock_s,
      halted_reason: haltedReasonPreflight,
    });
    // Round 3, F1(a): reserve one request against every provider_quota row
    // this run's provider/model matches, atomically with the gate check and
    // insert above. Marked quota_reserved so ingest (src/ingest.mjs) never
    // double-counts this run's request from its real event count (F1(c)).
    //
    // Blind review NF4 (low-medium): `reserveRequest` returns the count of
    // provider_quota rows it actually incremented, which is zero when no
    // window matches this run's provider/model yet - nothing was reserved,
    // so `quota_reserved` must stay 0. Before this fix it was set to 1
    // unconditionally: if a window was declared for this provider/model
    // *later* and this run's events were then ingested, `ingest` saw
    // `quota_reserved = 1` and (per F1(c) above) assumed a request had
    // already been counted for it, permanently dropping this run's real
    // request count from that new window's `used_requests`.
    const reservedCount = reserveRequest(db, { provider, model });
    if (reservedCount > 0) {
      db.prepare('UPDATE task_runs SET quota_reserved = 1 WHERE id = ?').run(run.id);
      run.quota_reserved = 1;
    }
    transition(db, task.id, 'working');
    return { ok: true, run };
  });

  if (!outcome.ok) {
    return { result: failGate(err, db, task.id, outcome.gate) };
  }

  return { result: { code: 0, stdout: outcome.run.id }, run: outcome.run, task, outDir, adapterName };
}

/**
 * Shared body of run:end (docs/cli.md "Post run guards, files touched,
 * status"), extracted so `run:launch --retry` (Phase 1a real-batch fix F1)
 * can finalize each attempt in process - the same guards, the same
 * failure_class classification, no subprocess - rather than duplicating
 * this logic or shelling out to itself. Returns `{code, stdout, failureClass}`;
 * `failureClass` is `'provider_unavailable'` or `null`, always present, so a
 * caller need not re-parse `stdout`/`--json` to make a retry decision.
 */
function doRunEnd({ db, config, flags, err }) {
  if (!flags.run) return { ...fail(err, 1, 'usage', 'run:end requires --run <id>'), failureClass: null };
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(flags.run);
  if (!run) return { ...fail(err, 1, 'not_found', `no such run: ${flags.run}`), failureClass: null };
  const task = getTask(db, run.task_id);
  if (!task) return { ...fail(err, 1, 'not_found', `no such task: ${run.task_id}`), failureClass: null };

  // If the watchdog itself died, apply the wall clock rule now.
  retroactiveWallclock(db, config, run, new Date());
  const afterRetro = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  if (afterRetro.status === 'halted' && afterRetro.halted_reason === 'wallclock') {
    return { code: 0, stdout: afterRetro.status, failureClass: null };
  }

  // F3: a Windows unsigned exit code (4294967295 for a native -1) is
  // normalized to its signed value the moment it enters the ledger, whether
  // it arrived via --exit or was read off exit.txt.
  let exitCode;
  if (flags.exit !== undefined) {
    exitCode = normalizeExitCode(Number(flags.exit));
  } else {
    const exitPath = join(run.out_dir, 'exit.txt');
    exitCode = normalizeExitCode(existsSync(exitPath) ? Number(readFileSync(exitPath, 'utf8').trim()) : 0);
  }

  const touched = filesTouched(run.worktree, task.base_commit);
  const filesTouchedCount = touched.length;

  let status = exitCode === 0 ? 'ok' : 'fail';
  let haltedReason = null;

  if (filesTouchedCount > config.limits.files_touched_max) {
    status = 'halted';
    haltedReason = 'files_touched';
    escalate(db, {
      taskId: task.id,
      runId: run.id,
      reason: 'files_touched',
      severity: 'halt',
      detail: `${filesTouchedCount} files touched, limit ${config.limits.files_touched_max}: ${touched.join(', ')}`,
    });
  }

  const editDetection = testEditDetection(touched, config.test_patterns, task.task_class);
  if (editDetection.touched) {
    escalate(db, {
      taskId: task.id,
      runId: run.id,
      reason: 'test_edit',
      severity: 'warn',
      detail: `touched test files: ${editDetection.files.join(', ')}`,
    });
  }

  const failureStreak = toolFailureStreak(join(run.out_dir, 'events.jsonl'), 3);
  if (failureStreak.hit) {
    escalate(db, {
      taskId: task.id,
      runId: run.id,
      reason: 'tool_failure',
      severity: 'warn',
      detail: `${failureStreak.tool ?? 'unknown tool'}: ${failureStreak.error ?? ''}`.trim(),
    });
  }

  const scope = scopeMarker(run.out_dir);
  if (scope.found && status !== 'halted') {
    status = 'fail';
    haltedReason = scope.line;
  }

  if ((run.agent === 'builder' || run.agent === 'solo') && exitCode === 0 && status === 'ok') {
    if (missingPatch(run.out_dir)) {
      status = 'fail';
      haltedReason = 'no_patch';
    }
  }

  // Phase 1a real-batch fix F1: a run that failed only because the stream
  // ended on a terminal retryable provider error (a 429/5xx), with no
  // successful completion anywhere in events.jsonl, is not an ordinary
  // agent failure - it never got a turn. Only considered once `status` has
  // settled to a plain `fail` (files_touched/scope/no_patch already claimed
  // it for a more specific reason, and those take precedence: this run did
  // touch too many files, or did exceed scope, regardless of what the
  // provider also did). No escalation is written here - src/limits.mjs's
  // NON_COUNTABLE_FAILURE_CLASSES / checkAttempts already exclude it from
  // the attempt count by reading this column directly, and `run:launch
  // --retry`'s own loop (docs/state-machine.md "Attempt counting", this
  // command's own doc comment above) is the one place that ever writes a
  // provider_unavailable escalation - exactly once, when its retry budget
  // is exhausted, never once per individual run.
  let failureClass = null;
  if (status === 'fail' && haltedReason === null) {
    const classification = classifyFailureClass(join(run.out_dir, 'events.jsonl'));
    failureClass = classification.failureClass;
  }

  const summary = flags.summary ?? run.summary;
  const tokensIn = flags['tokens-in'] !== undefined ? Number(flags['tokens-in']) : run.tokens_in;
  const tokensOut = flags['tokens-out'] !== undefined ? Number(flags['tokens-out']) : run.tokens_out;
  const costUsd = flags.cost !== undefined ? Number(flags.cost) : run.cost_usd;

  db.prepare(
    `UPDATE task_runs SET status = ?, exit_code = ?, files_touched = ?, halted_reason = ?,
       tokens_in = ?, tokens_out = ?, cost_usd = ?, summary = ?, ended_at = ?, failure_class = ?
     WHERE id = ?`
  ).run(status, exitCode, filesTouchedCount, haltedReason, tokensIn, tokensOut, costUsd, summary, nowIso(), failureClass, run.id);

  if (flags.json) {
    return {
      code: 0,
      stdout: JSON.stringify({ status, exit_code: exitCode, halted_reason: haltedReason, failure_class: failureClass }),
      failureClass,
    };
  }
  return { code: 0, stdout: status, failureClass };
}

export function register(registry) {
  registry.add('preflight', {
    description: 'Guards, exit 2 or 4 on refusal',
    async handler({ db, config, flags, err }) {
      const need = missing(flags, ['worktree', 'provider']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const result = await runPreflight(db, config, {
        worktree: flags.worktree,
        provider: flags.provider,
        model: flags.model ?? null,
        isPublic: !!flags.public,
        allowDirty: !!flags['allow-dirty'],
        strict: !!flags.strict,
        taskId: flags.task,
        // Optional: docs/adapters.md "Windows command resolution" - lets an
        // operator check "will run:launch even find this harness on PATH"
        // ahead of a real run:start/run:launch, which always pass their own
        // resolved adapterName through automatically.
        adapterName: flags.adapter ?? null,
      });
      if (!result.ok) return fail(err, result.code, result.reason, result.detail ?? '');
      return { code: 0, stdout: 'ok' };
    },
  });

  registry.add('run:start', {
    description: 'Limit and quota gates, insert run, print run id',
    async handler(ctx) {
      const started = await doRunStart(ctx);
      return started.result;
    },
  });

  /**
   * One launch attempt: run:start plus adapter spawn plus watchdog (the
   * body run:launch has always had). Returns `{ok:false, result}` on any
   * failure to relay verbatim, or `{ok:true, run, task, outDir}` once the
   * harness has been spawned (or, for `--sync`, has already finished).
   * Factored out of the registry handler so `--retry` (Phase 1a real-batch
   * fix F1) can call it more than once for the same `--task`/`--agent`
   * without duplicating this body.
   */
  async function launchAttempt(ctx) {
    const { db, config, flags, err } = ctx;

    const started = await doRunStart(ctx, { checkCommandResolution: true });
    if (started.result.code !== 0) return { ok: false, result: started.result };
    const { run, task, outDir, adapterName } = started;

    let prompt;
    try {
      prompt = readFileSync(flags['prompt-file'], 'utf8');
    } catch (e) {
      return { ok: false, result: fail(err, 1, 'usage', `cannot read --prompt-file: ${e.message}`) };
    }

    let adapter;
    try {
      adapter = await getAdapter(adapterName);
    } catch (e) {
      return { ok: false, result: fail(err, e.code ?? 1, 'usage', e.message) };
    }

      const timeoutMs = config.limits.wallclock_s * 1000;

      // Review round 1, F2: one launch path for every adapter. By default
      // (no `--sync`) every adapter - fake included - goes through
      // buildArgv() + launchDetached(), which tees the harness's stdout
      // through runner.mjs so events.jsonl is written live (from the
      // adapter's createStreamParser(), when it has one) and out.txt is
      // redacted line by line (F3) exactly the same way for a real harness
      // or the fake one. `--sync` is the one escape hatch, calling the
      // adapter's own blocking run() in process instead - kept only for the
      // e2e/loop fixtures (test/e2e.test.mjs, test/e2e-autonomy.test.mjs,
      // test/loop.test.mjs) that need the fake run to have already finished,
      // synchronously, by the time this command returns.
      if (flags.sync) {
        const fixturePath = process.env.CORTEX_FAKE_FIXTURE;
        const syncResult = await adapter.run({
          prompt,
          cwd: task.worktree,
          agent: flags.agent,
          model: run.model,
          outDir,
          timeoutMs,
          env: process.env,
          detach: !!flags.detach,
          // D2: harmless for claude/codex/fake, which never read this -
          // only opencode's run()/buildArgv do (see the non-sync branch
          // below for the fuller comment).
          agentDef: config.agents?.[flags.agent] ?? {},
          ...(adapterName === 'fake'
            ? { fixture: fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : undefined }
            : {}),
        });
        // Blocker 1: every real adapter's run() now reports back which
        // channel it actually used (src/adapters/prompt-delivery.mjs);
        // the fake adapter never puts a prompt into argv at all (it is
        // fixture driven, not prompt driven), so it has nothing to report
        // and this defaults to 'argv' as a bookkeeping placeholder.
        db.prepare('UPDATE task_runs SET prompt_delivery = ? WHERE id = ?').run(
          syncResult?.promptDelivery ?? 'argv',
          run.id
        );
      } else {
        const adapterConfig = config.adapters?.[adapterName] ?? {};
        let dataHome;
        if (adapterName === 'opencode') {
          // Review round 1, F4: a per agent OpenCode data dir, so two
          // OpenCode processes never share XDG_DATA_HOME and deadlock on
          // OpenCode's own database (docs/adapters.md "Concurrency note").
          // opencode.mjs's buildArgv joins `agent` onto `dataHome` itself
          // (see test/adapters.test.mjs "data home isolation"), so this is
          // the *base* dir - the directory actually used by the spawned
          // process is dataHome/<agent>, which is what we create here.
          dataHome = join(config.runs, '.opencode-data');
          mkdirSync(join(dataHome, flags.agent), { recursive: true });
        }
        // Windows command resolution (docs/adapters.md "Windows command
        // resolution"): `adapterConfig.cmd` (the review round 1 F2 test
        // harness override) still wins outright when set; otherwise
        // `config.tools.<adapterName>` (an operator-supplied argv array)
        // skips resolveCommand entirely; otherwise each adapter's own
        // buildArgv resolves the real command itself.
        //
        // D2: `agentDef` is this kit's own config.agents[<agent>] block
        // (opencode.mjs's buildArgv reads `.opencode`/`.template`/
        // `.read_only` off it to generate an OpenCode `agent.<name>`
        // definition - see docs/adapters.md "opencode: agent definition and
        // permission binding"). Harmless to pass to every adapter; only
        // opencode's buildArgv looks at it.
        const agentDef = config.agents?.[flags.agent] ?? {};
        const {
          cmd, args, env, resolvedFrom, credentialsEvent,
          promptDelivery, stdin: stdinText, promptDeliveryEvent: pdEvent,
        } = adapter.buildArgv({
          prompt,
          cwd: task.worktree,
          agent: flags.agent,
          model: run.model,
          outDir,
          dataHome,
          cmd: adapterConfig.cmd,
          argsPrefix: adapterConfig.argsPrefix,
          toolOverride: config.tools?.[adapterName],
          agentDef,
        });
        if (resolvedFrom === null) {
          err(`cortexctl: warn: ${adapterName} not found on PATH; spawn will fail with ENOENT`);
        }

        // Blocker 1 (real defect: `spawn ENAMETOOLONG` launching a review of
        // a 492-addition PR): whichever adapter this is, when its buildArgv
        // chose a delivery other than 'argv' the actual prompt text comes
        // back on `stdin` here - it must never be handed to launchDetached
        // as an argv element (that would just move the same overflow one
        // process over, into the detached runner's own spawn of *itself*).
        // Instead it is written once, redacted at rest exactly like out.txt
        // (docs/adapters.md "spawn helper and credential boundary"), and only
        // the resulting short file path crosses into runner.mjs's own argv -
        // see src/adapters/runner.mjs's `--stdin-file`, which pipes this
        // file's exact bytes onto the harness's real stdin.
        let stdinFile;
        if (stdinText !== undefined) {
          stdinFile = join(outDir, 'prompt.txt');
          writeFileSync(stdinFile, redact(stdinText));
        }
        db.prepare('UPDATE task_runs SET prompt_delivery = ? WHERE id = ?').run(
          promptDelivery ?? 'argv',
          run.id
        );

        launchDetached({
          argv: { cmd, args, env },
          cwd: task.worktree,
          outDir,
          timeoutMs,
          adapter: adapterName,
          eventsPath: join(outDir, 'events.jsonl'),
          // D1/Blocker 1: opencode's own credentials.forwarded/missing event
          // and/or this launch's prompt.delivery event, seeded into
          // events.jsonl by runner.mjs before the harness spawns (see
          // spawn.mjs launchDetached's doc comment). `credentialsEvent` is
          // undefined for every adapter but opencode; `pdEvent` is returned
          // by all three real adapters' buildArgv (never fake's, which has
          // no prompt of its own to report on).
          initialEvents: [credentialsEvent, pdEvent].filter(Boolean),
          stdinFile,
        });

        // Review round 2, R2-1: doRunStart's insertRun never had a pid to
        // write (the harness doesn't exist yet at that point), so
        // task_runs.pid stayed null and the watchdog's killTree(run.pid) was
        // a no-op on a stall or wall clock breach. runner.mjs writes
        // <outDir>/pid.txt immediately after spawning the harness, so poll
        // for it here (bounded, 50ms steps, no long sleeps) and persist it
        // as soon as it appears. If it never shows up within the deadline,
        // leave task_runs.pid null - the watchdog's own pid.txt fallback
        // (src/guards/watchdog.mjs resolvePid) still covers it later - and
        // warn on stderr without breaking the one-line stdout contract for
        // this zero-exit path.
        const pid = await pollPidFile(join(outDir, 'pid.txt'), 3000, 50);
        if (pid != null) {
          db.prepare('UPDATE task_runs SET pid = ? WHERE id = ?').run(pid, run.id);
        } else {
          err('cortexctl: warn: pid.txt not found within 3s');
        }
      }

      // A `--sync` launch (see above) has already run to completion and
      // written done.marker before we get here, so a watchdog for it would
      // have nothing left to watch - skip spawning one rather than leaving
      // a redundant detached process (and its own db connection) racing the
      // caller's very next command (docs/state-machine.md "Wall clock
      // watchdog": "cortexctl watch ... is started by the launcher
      // immediately after the harness process" - a harness that has already
      // finished needs no watcher). Every detached launch is still running
      // at this point, so it always gets one. `--config` is forwarded (when
      // the run used one) so the watchdog enforces the same `stall_s`/
      // limits the run started under, not whatever config a bare cwd lookup
      // would otherwise find.
      if (!existsSync(join(outDir, 'done.marker'))) {
        const watchArgs = [CLI_PATH, 'watch', '--run', run.id, '--db', config.db];
        if (config.configPath) watchArgs.push('--config', config.configPath);
        const watcher = spawn(process.execPath, watchArgs, {
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
        });
        watcher.unref();
      }

      return { ok: true, run, task, outDir };
  }

  registry.add('run:launch', {
    description: 'run:start plus adapter spawn plus watchdog',
    async handler(ctx) {
      const { db, flags, err, config } = ctx;
      const need = missing(flags, ['task', 'agent', 'prompt-file']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }

      // --retry (Phase 1a real-batch fix F1): flag omitted entirely keeps
      // run:launch's original behaviour exactly - one attempt, spawn and
      // return immediately (fire and forget; a detached launch is watched
      // by `cortexctl watch`/finalized by a later `run:end`, never awaited
      // here). Passing --retry (even --retry 0) opts into this run waiting
      // for its own completion so it can tell a provider outage from a real
      // agent failure and, if asked, relaunch - see docs/cli.md's
      // `run:launch` row and docs/state-machine.md's exit code table (7).
      if (flags.retry === undefined) {
        const attempt = await launchAttempt(ctx);
        if (!attempt.ok) return attempt.result;
        return { code: 0, stdout: attempt.run.id };
      }

      const maxExtraAttempts = Math.max(0, Number(flags.retry) || 0);
      const backoffS = flags['retry-backoff-s'] !== undefined ? Number(flags['retry-backoff-s']) : 30;
      const totalAttempts = maxExtraAttempts + 1;

      for (let attemptNum = 1; ; attemptNum++) {
        const attempt = await launchAttempt(ctx);
        if (!attempt.ok) return attempt.result; // a gate/usage failure, unrelated to the provider - surface as-is, no retry.
        const { run, task, outDir } = attempt;

        // The watchdog (spawned inside launchAttempt, or --sync's own
        // synchronous run() above) is what guarantees this run eventually
        // gets a done.marker one way or another; the extra minute here is
        // slack for process scheduling, not a second enforcement of
        // wallclock_s.
        await waitForDoneMarker(outDir, { timeoutMs: config.limits.wallclock_s * 1000 + 60000 });

        const ended = doRunEnd({ db, config, flags: { run: run.id }, err });
        if (ended.code !== 0) return ended;

        if (ended.failureClass !== 'provider_unavailable') {
          return { code: 0, stdout: run.id };
        }

        if (attemptNum >= totalAttempts) {
          // Exactly one warn escalation on give-up, never one per retry
          // (docs/ledger.md escalations.reason "provider_unavailable" -
          // added by this fix, no existing reason fit a provider's own
          // service being unavailable, as opposed to this kit's own quota
          // ceilings).
          const escalation = escalate(db, {
            taskId: task.id,
            runId: run.id,
            reason: 'provider_unavailable',
            severity: 'warn',
            detail: `provider unavailable after ${attemptNum} attempt(s) (retry budget ${maxExtraAttempts} extra attempt(s) exhausted)`,
          });
          return fail(
            err,
            7,
            'provider_unavailable',
            `${attemptNum} attempt(s) exhausted, retry budget ${maxExtraAttempts} (run ${run.id}, escalation ${escalation.id})`
          );
        }

        const waitMs = computeBackoffMs(backoffS, attemptNum);
        err(
          `cortexctl: provider_unavailable: waiting ${Math.round(waitMs / 1000)}s before retry attempt ${attemptNum + 1}/${totalAttempts} (run ${run.id})`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        // Loop continues: the next launchAttempt(ctx) reuses the same
        // --task/--agent, creating a new run on the same task
        // (docs/state-machine.md "Attempt counting": a provider_unavailable
        // run never counts against builder_attempts_max, so this never
        // trips that gate on its own).
      }
    },
  });

  registry.add('run:end', {
    description: 'Post run guards, files touched, status',
    handler(ctx) {
      return doRunEnd(ctx);
    },
  });

  registry.add('watch', {
    description: 'Watchdog process, started by run:launch',
    async handler({ db, config, flags, err }) {
      if (!flags.run) return fail(err, 1, 'usage', 'watch requires --run <id>');
      const result = await watchRun(db, config, { runId: flags.run });
      if (result === 'not_found') return fail(err, 1, 'not_found', `no such run: ${flags.run}`);
      return { code: 0, stdout: result };
    },
  });

  registry.add('msg', {
    description: 'Insert agent message',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'kind', 'from', 'to', 'body']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchivedMsg = checkNotArchived(task);
      if (!notArchivedMsg.ok) return fail(err, 6, 'archived', notArchivedMsg.detail);

      let body = flags.body;
      if (existsSync(body)) {
        try {
          body = readFileSync(body, 'utf8');
        } catch {
          // fall through and store the literal value
        }
      }

      const msg = insertMessage(db, {
        task_id: task.id,
        run_id: flags.run,
        sender: flags.from,
        recipient: flags.to,
        kind: flags.kind,
        body,
      });
      return { code: 0, stdout: msg.id };
    },
  });

  registry.add('artifact', {
    description: 'Insert artifact with sha256 and bytes',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'kind', 'path']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchivedArtifact = checkNotArchived(task);
      if (!notArchivedArtifact.ok) return fail(err, 6, 'archived', notArchivedArtifact.detail);
      const artifact = insertArtifact(db, {
        task_id: task.id,
        run_id: flags.run,
        kind: flags.kind,
        path: flags.path,
      });
      return { code: 0, stdout: artifact.id };
    },
  });

  registry.add('test', {
    description: 'Record a suite',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'suite', 'status']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      if (!VALID_TEST_STATUS.has(flags.status)) {
        return fail(err, 1, 'usage', `--status must be one of ${[...VALID_TEST_STATUS].join(', ')}, got ${flags.status}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchivedTest = checkNotArchived(task);
      if (!notArchivedTest.ok) return fail(err, 6, 'archived', notArchivedTest.detail);

      const row = insertTest(db, {
        task_id: task.id,
        run_id: flags.run,
        suite: flags.suite,
        command: flags.command,
        status: flags.status,
        passed: flags.passed !== undefined ? Number(flags.passed) : 0,
        failed: flags.failed !== undefined ? Number(flags.failed) : 0,
        duration_ms: flags['duration-ms'] !== undefined ? Number(flags['duration-ms']) : undefined,
        log_path: flags.log,
      });
      return { code: 0, stdout: row.id };
    },
  });

  registry.add('intervene', {
    description: 'Record a human intervention',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'kind', 'detail']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      if (!VALID_INTERVENE_KINDS.has(flags.kind)) {
        return fail(
          err,
          1,
          'usage',
          `--kind must be one of ${[...VALID_INTERVENE_KINDS].join(', ')}, got ${flags.kind}`
        );
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchivedIntervene = checkNotArchived(task);
      if (!notArchivedIntervene.ok) return fail(err, 6, 'archived', notArchivedIntervene.detail);

      const row = insertIntervention(db, {
        task_id: task.id,
        run_id: flags.run,
        kind: flags.kind,
        minutes: flags.minutes !== undefined ? Number(flags.minutes) : undefined,
        detail: flags.detail,
      });
      return { code: 0, stdout: row.id };
    },
  });

  registry.add('task:close', {
    description: 'Close gate, see state machine',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'outcome']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      if (!VALID_OUTCOMES.has(flags.outcome)) {
        return fail(err, 1, 'usage', `--outcome must be one of ${[...VALID_OUTCOMES].join(', ')}, got ${flags.outcome}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchivedClose = checkNotArchived(task);
      if (!notArchivedClose.ok) return fail(err, 6, 'archived', notArchivedClose.detail);

      if (task.kind === 'implement') {
        const tests = listTests(db, task.id);
        const notedNoTests = (task.notes ?? '').includes('no_tests');
        if (tests.length === 0 && !flags['no-tests'] && !notedNoTests) {
          return fail(err, 6, 'close_gate', 'implement task requires at least one test_results row or --no-tests');
        }
      }

      const openHalts = openHaltEscalations(db, task.id);
      if (openHalts.length > 0) {
        return fail(err, 6, 'close_gate', `${openHalts.length} open halt escalation(s) must be resolved first`);
      }

      const toStatus = OUTCOME_TO_STATUS[flags.outcome];
      try {
        transition(db, task.id, toStatus);
      } catch (e) {
        return fail(err, e.code ?? 6, 'task_state', e.message);
      }

      const noteParts = [];
      if (flags['no-tests']) noteParts.push('no_tests');
      if (flags.note) noteParts.push(flags.note);
      const mergedNotes = noteParts.length
        ? task.notes
          ? `${task.notes}; ${noteParts.join('; ')}`
          : noteParts.join('; ')
        : task.notes;

      db.prepare(
        'UPDATE tasks SET closed_at = ?, outcome = ?, pr_url = COALESCE(?, pr_url), human_edits = COALESCE(?, human_edits), notes = ? WHERE id = ?'
      ).run(
        nowIso(),
        flags.outcome,
        flags.pr ?? null,
        flags['human-edits'] !== undefined ? Number(flags['human-edits']) : null,
        mergedNotes,
        task.id
      );

      for (const v of listVerdicts(db, task.id)) {
        if (v.arm == null) {
          db.prepare('UPDATE review_verdicts SET arm = ? WHERE id = ?').run(task.arm, v.id);
        }
      }

      const stdout = task.sibling_id ? `ok\ncompare hint: cortexctl compare --task ${task.id}` : 'ok';
      return { code: 0, stdout };
    },
  });

  registry.add('task:resolve', {
    description: 'Resolve open halt escalations, task back to working, records intervention',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'note']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchivedResolve = checkNotArchived(task);
      if (!notArchivedResolve.ok) return fail(err, 6, 'archived', notArchivedResolve.detail);
      try {
        const result = resolveEscalations(db, task.id, {
          note: flags.note,
          retryAuthorized: !!flags['retry-authorized'],
        });
        return { code: 0, stdout: `resolved ${result.resolved} escalation(s)` };
      } catch (e) {
        return fail(err, e.code ?? 6, 'task_state', e.message);
      }
    },
  });

  registry.add('task:reject', {
    description: 'Architect refuses the brief',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'note']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchivedReject = checkNotArchived(task);
      if (!notArchivedReject.ok) return fail(err, 6, 'archived', notArchivedReject.detail);
      try {
        transition(db, task.id, 'rejected', { note: flags.note });
      } catch (e) {
        return fail(err, e.code ?? 6, 'task_state', e.message);
      }
      return { code: 0, stdout: 'ok' };
    },
  });
}
