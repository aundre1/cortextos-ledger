// Run and task-lifecycle commands (docs/cli.md "Runs" and part of "Tasks",
// "Tests and closing"): preflight, run:start, run:launch, run:end, watch,
// msg, artifact, test, intervene, task:close, task:resolve, task:reject.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nowIso } from '../db.mjs';
import {
  getTask,
  listRuns,
  listTests,
  listEscalations,
  listVerdicts,
  insertRun,
  insertMessage,
  insertArtifact,
  insertTest,
  insertIntervention,
} from '../ledger.mjs';
import {
  checkAttempts,
  checkSpend,
  checkQuota,
  transition,
  escalate,
  resolveEscalations,
  retroactiveWallclock,
} from '../limits.mjs';
import { preflight as runPreflight } from '../guards/preflight.mjs';
import {
  filesTouched,
  testEditDetection,
  toolFailureStreak,
  scopeMarker,
  missingPatch,
} from '../guards/postrun.mjs';
import { getAdapter } from '../adapters/index.mjs';
import { launchDetached } from '../adapters/spawn.mjs';
import { watch as watchRun } from '../guards/watchdog.mjs';
import { activeFor } from '../policy.mjs';

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

function computeSeq(db, taskId) {
  return listRuns(db, taskId).length + 1;
}

function openHaltEscalations(db, taskId) {
  return listEscalations(db, taskId).filter((e) => e.severity === 'halt' && !e.resolved_at);
}

/**
 * Shared body of run:start, reused by run:launch. On success returns
 * { result: {code:0, stdout: runId}, run, task, outDir, adapterName }; on
 * any gate failure returns { result: <the failing {code}> } only.
 */
async function doRunStart({ db, config, flags, err }) {
  const need = missing(flags, ['task', 'agent']);
  if (need.length) {
    return { result: fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`) };
  }

  const task = getTask(db, flags.task);
  if (!task) return { result: fail(err, 1, 'not_found', `no such task: ${flags.task}`) };

  if (!START_ALLOWED_STATUSES.has(task.status)) {
    return {
      result: fail(err, 6, 'task_state', `task ${task.id} is ${task.status}, cannot start a run`),
    };
  }
  if (task.status === 'input_required') {
    const openHalts = openHaltEscalations(db, task.id);
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

  const attempts = checkAttempts(db, config, task.id, agent);
  if (!attempts.ok) {
    const escalation = escalate(db, {
      taskId: task.id,
      reason: 'retry_limit',
      severity: 'halt',
      detail: `${attempts.used}/${attempts.max} attempts used`,
    });
    return {
      result: fail(err, 3, 'retry_limit', `${attempts.used}/${attempts.max} attempts used (escalation ${escalation.id})`),
    };
  }

  const spend = checkSpend(db, config, task.id, agent, model);
  if (!spend.ok) {
    const escalation = escalate(db, {
      taskId: task.id,
      reason: 'budget',
      severity: 'halt',
      detail: `projected $${spend.projected.toFixed(4)} exceeds limit $${spend.max}`,
    });
    return {
      result: fail(
        err,
        3,
        'budget',
        `projected $${spend.projected.toFixed(4)} exceeds limit $${spend.max} (escalation ${escalation.id})`
      ),
    };
  }

  const quota = checkQuota(db, config, provider, model, spend.projectedNext, { isPublic: !!flags.public });
  if (!quota.ok) {
    const escalation = escalate(db, {
      taskId: task.id,
      reason: 'quota',
      severity: 'halt',
      detail: quota.detail ?? quota.reason,
    });
    return {
      result: fail(err, 4, quota.reason, `${quota.detail ?? quota.reason} (escalation ${escalation.id})`),
    };
  }

  let haltedReasonPreflight = null;
  if (!flags['no-preflight']) {
    const pf = await runPreflight(db, config, {
      worktree: task.worktree,
      provider,
      model,
      isPublic: !!flags.public,
      allowDirty: !!flags['allow-dirty'],
      strict: !!flags.strict,
      taskId: task.id,
    });
    if (!pf.ok) {
      return { result: fail(err, pf.code, pf.reason, pf.detail ?? '') };
    }
  } else {
    haltedReasonPreflight = 'preflight_skipped';
  }

  const seq = computeSeq(db, task.id);
  const outDir = join(config.runs, task.id, agent);
  const run = insertRun(db, {
    task_id: task.id,
    seq,
    agent,
    provider,
    model,
    status: 'running',
    worktree: task.worktree,
    out_dir: outDir,
    wallclock_limit_s: config.limits.wallclock_s,
    halted_reason: haltedReasonPreflight,
  });

  transition(db, task.id, 'working');

  return { result: { code: 0, stdout: run.id }, run, task, outDir, adapterName };
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

  registry.add('run:launch', {
    description: 'run:start plus adapter spawn plus watchdog',
    async handler(ctx) {
      const { db, config, flags, err } = ctx;
      const need = missing(flags, ['task', 'agent', 'prompt-file']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }

      const started = await doRunStart(ctx);
      if (started.result.code !== 0) return started.result;
      const { run, task, outDir, adapterName } = started;

      let prompt;
      try {
        prompt = readFileSync(flags['prompt-file'], 'utf8');
      } catch (e) {
        return fail(err, 1, 'usage', `cannot read --prompt-file: ${e.message}`);
      }

      let adapter;
      try {
        adapter = await getAdapter(adapterName);
      } catch (e) {
        return fail(err, e.code ?? 1, 'usage', e.message);
      }

      const timeoutMs = config.limits.wallclock_s * 1000;

      if (adapterName === 'fake') {
        const fixturePath = process.env.CORTEX_FAKE_FIXTURE;
        await adapter.run({
          prompt,
          cwd: task.worktree,
          agent: flags.agent,
          model: run.model,
          outDir,
          timeoutMs,
          env: process.env,
          detach: !!flags.detach,
          fixture: fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : undefined,
        });
      } else {
        const { cmd, args, env } = adapter.buildArgv({
          prompt,
          cwd: task.worktree,
          agent: flags.agent,
          model: run.model,
          outDir,
        });
        launchDetached({ argv: { cmd, args, env }, cwd: task.worktree, outDir, timeoutMs });
      }

      // The fake adapter runs entirely in-process and writes done.marker
      // before `adapter.run()` above returns, so a watchdog for it would
      // have nothing left to watch - skip spawning one rather than leaving
      // a redundant detached process (and its own db connection) racing the
      // caller's very next command (docs/state-machine.md "Wall clock
      // watchdog": "cortexctl watch ... is started by the launcher
      // immediately after the harness process" - a harness that has already
      // finished needs no watcher). Real adapters always go through
      // launchDetached and are still running at this point, so they always
      // get one. `--config` is forwarded (when the run used one) so the
      // watchdog enforces the same `stall_s`/limits the run started under,
      // not whatever config a bare cwd lookup would otherwise find.
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

      return { code: 0, stdout: run.id };
    },
  });

  registry.add('run:end', {
    description: 'Post run guards, files touched, status',
    handler({ db, config, flags, err }) {
      if (!flags.run) return fail(err, 1, 'usage', 'run:end requires --run <id>');
      const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(flags.run);
      if (!run) return fail(err, 1, 'not_found', `no such run: ${flags.run}`);
      const task = getTask(db, run.task_id);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${run.task_id}`);

      // If the watchdog itself died, apply the wall clock rule now.
      retroactiveWallclock(db, config, run, new Date());
      const afterRetro = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
      if (afterRetro.status === 'halted' && afterRetro.halted_reason === 'wallclock') {
        return { code: 0, stdout: afterRetro.status };
      }

      let exitCode;
      if (flags.exit !== undefined) {
        exitCode = Number(flags.exit);
      } else {
        const exitPath = join(run.out_dir, 'exit.txt');
        exitCode = existsSync(exitPath) ? Number(readFileSync(exitPath, 'utf8').trim()) : 0;
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

      const summary = flags.summary ?? run.summary;
      const tokensIn = flags['tokens-in'] !== undefined ? Number(flags['tokens-in']) : run.tokens_in;
      const tokensOut = flags['tokens-out'] !== undefined ? Number(flags['tokens-out']) : run.tokens_out;
      const costUsd = flags.cost !== undefined ? Number(flags.cost) : run.cost_usd;

      db.prepare(
        `UPDATE task_runs SET status = ?, exit_code = ?, files_touched = ?, halted_reason = ?,
           tokens_in = ?, tokens_out = ?, cost_usd = ?, summary = ?, ended_at = ?
         WHERE id = ?`
      ).run(status, exitCode, filesTouchedCount, haltedReason, tokensIn, tokensOut, costUsd, summary, nowIso(), run.id);

      if (flags.json) {
        return { code: 0, stdout: JSON.stringify({ status, exit_code: exitCode, halted_reason: haltedReason }) };
      }
      return { code: 0, stdout: status };
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
      try {
        transition(db, task.id, 'rejected', { note: flags.note });
      } catch (e) {
        return fail(err, e.code ?? 6, 'task_state', e.message);
      }
      return { code: 0, stdout: 'ok' };
    },
  });
}
