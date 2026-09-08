// State machine transitions, the five hard limits, and escalations
// (docs/state-machine.md, docs/ledger.md "Invariants enforced in code, not
// in DDL"). Pure-ish helpers: every function takes `db` first and plain
// values; only the CLI layer (src/commands/runs.mjs) calls process.exit.

import { nowIso } from './db.mjs';
import {
  getTask,
  setTaskStatus,
  countRuns,
  countVerdicts,
  sumCost,
  insertEscalation,
  insertIntervention,
} from './ledger.mjs';
import { rollQuota, syncConfigQuota, reservedSpend } from './quota.mjs';

// ---------------------------------------------------------------------------
// Attempts (docs/state-machine.md "Attempt counting")
// ---------------------------------------------------------------------------

/**
 * Attempts count runs whose agent is `builder` or `solo` on the same task,
 * regardless of status. A `human_interventions` row of kind
 * `retry_authorized` (written by task:resolve --retry-authorized) raises the
 * ceiling by one, permanently, per authorization.
 */
export function checkAttempts(db, config, taskId, agent) {
  const used = countRuns(db, taskId, ['builder', 'solo']);
  const authorized = db
    .prepare(
      "SELECT COUNT(*) AS c FROM human_interventions WHERE task_id = ? AND kind = 'retry_authorized'"
    )
    .get(taskId).c;
  const max = config.limits.builder_attempts_max + authorized;
  const countable = agent === 'builder' || agent === 'solo';
  return { ok: !countable || used < max, used, max };
}

// ---------------------------------------------------------------------------
// Challenge cycles (docs/state-machine.md "Blind review gate")
// ---------------------------------------------------------------------------

/**
 * `used` is the highest challenge_seq stored for the task so far (0 for
 * "only the first blind verdict exists", 1 after the single allowed
 * challenge cycle). A second challenge cycle is refused once
 * `used >= challenge_cycles_max`.
 */
export function checkChallenge(db, config, taskId) {
  const row = db
    .prepare('SELECT COALESCE(MAX(challenge_seq), 0) AS m FROM review_verdicts WHERE task_id = ?')
    .get(taskId);
  const used = row.m;
  const max = config.limits.challenge_cycles_max;
  return { ok: used < max, used, max };
}

// ---------------------------------------------------------------------------
// Spend projection (docs/state-machine.md "Spend projection at run:start")
// ---------------------------------------------------------------------------

/**
 * Median cost_usd of ended runs (any outcome, not just "ok") for the same
 * agent and model across the whole ledger (every task, not just `taskId` -
 * the docs say "across the ledger"). Zero when fewer than three such runs
 * exist, per docs. `taskId` is accepted (and unused here) to match the task
 * card's signature; `checkSpend` is the one that combines it with the
 * task's own actual spend.
 */
export function projectedSpend(db, config, taskId, agent, model) {
  const rows = db
    .prepare(
      "SELECT cost_usd FROM task_runs WHERE agent = ? AND model = ? AND status != 'running' ORDER BY cost_usd"
    )
    .all(agent, model);
  if (rows.length < 3) return 0;
  const costs = rows.map((r) => r.cost_usd);
  const mid = Math.floor(costs.length / 2);
  return costs.length % 2 !== 0 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2;
}

/**
 * Projected total spend for the task if one more run of this agent/model
 * were to happen: actual spend so far, plus the median cost of similar runs
 * elsewhere in the ledger (0 when there isn't enough history to project).
 */
export function checkSpend(db, config, taskId, agent, model) {
  const actual = sumCost(db, taskId);
  const projectedNext = projectedSpend(db, config, taskId, agent, model);
  const projected = actual + projectedNext;
  const max = config.limits.spend_usd;
  return { ok: projected <= max, projected, actual, projectedNext, max };
}

// ---------------------------------------------------------------------------
// Quota (docs/state-machine.md "Quota gate at run:start", docs/guards.md)
// ---------------------------------------------------------------------------

/**
 * Rolls provider_quota windows forward, then checks headroom on every row
 * matching `provider` (model-specific rows and provider-wide rows where
 * model IS NULL) for one more request plus `projectedCost` dollars. A
 * provider with no provider_quota rows at all, and no `windows` declared in
 * `config.providers.<name>` either, has nothing to check against and
 * passes. `public_only` providers additionally require `isPublic`.
 *
 * Before rolling, `syncConfigQuota` seeds/refreshes provider_quota rows from
 * `config.providers.<name>.windows` (never touching a row `quota:set` has
 * already claimed with `source = 'manual'`) - this is what makes a ceiling
 * written only in the config file, and never passed to `quota:set`, an
 * actual enforced limit rather than dead documentation (docs/guards.md
 * "Provider quota").
 *
 * Escalations for both failure modes are written by the caller with reason
 * 'quota' (docs/ledger.md's escalation reason enum has no separate
 * 'public_only' value) - this function only classifies the failure via
 * `reason` in its own return value so the CLI can print the right message.
 */
export function checkQuota(db, config, provider, model, projectedCost = 0, { isPublic = false } = {}) {
  const providerConfig = config.providers?.[provider];
  if (providerConfig?.public_only && !isPublic) {
    return {
      ok: false,
      reason: 'public_only',
      // The escalations.reason enum (docs/ledger.md) has no separate
      // 'public_only' value, so the row is written with reason 'quota'
      // (unchanged) but its detail must still say which failure mode this
      // was; the "public_only:" prefix is that marker (Fable arbitration
      // 2026-09-07 / wave task 3d). The CLI's stderr line uses this
      // function's own `reason` field, not the escalation, so it still
      // prints the literal word `public_only`.
      detail: `public_only: provider ${provider} is public_only; --public was not passed`,
    };
  }

  syncConfigQuota(db, config, new Date());
  rollQuota(db, new Date());
  const rows = db
    .prepare('SELECT * FROM provider_quota WHERE provider = ? AND (model IS NULL OR model = ?)')
    .all(provider, model ?? null);

  // Round 3, F1(a)/(b): admission is now a real gate. `doRunStart` reserves
  // one request (src/quota.mjs reserveRequest) inside the same transaction
  // right after this passes, so the check below and the actual increment
  // stay in lockstep across concurrent callers. For limit_usd, real cost is
  // unknown until a run ends, so `reservedSpend` adds a pessimistic
  // reservation: every OTHER run currently running for this provider is
  // assumed to cost up to config.limits.spend_usd (the per-task budget cap
  // checkSpend also enforces).
  //
  // Arbitration (2026-09-08): the admitting call's OWN share must be
  // reserved pessimistically too, not just projected. With no run history
  // yet, `projectedCost` (the median of past runs) is 0, so a plain
  // `reserved + projectedCost` under-reserves this call by one full run --
  // e.g. limit_usd 10, spend_usd 4, two runs already running would admit a
  // third (reserved 8 + projectedCost 0 = 8 <= 10) even though that third
  // run could itself spend up to 4, for 12 of potential exposure against a
  // limit of 10. Its own share is therefore
  // `max(projectedCost, config.limits.spend_usd ?? 0)`: whichever is the
  // larger worst case, the historical median or the per-task budget cap.
  const reserved = reservedSpend(db, config, provider);
  const ownShare = Math.max(projectedCost, config.limits?.spend_usd ?? 0);

  for (const row of rows) {
    if (row.limit_requests != null && row.used_requests + 1 > row.limit_requests) {
      return {
        ok: false,
        reason: 'quota',
        detail: `${provider} ${row.model ?? '*'} ${row.window_kind}: requests ${row.used_requests + 1}/${row.limit_requests}`,
      };
    }
    if (row.limit_usd != null) {
      const committed = row.used_usd + reserved + ownShare;
      if (committed > row.limit_usd) {
        return {
          ok: false,
          reason: 'quota',
          detail: `${provider} ${row.model ?? '*'} ${row.window_kind}: usd ${committed.toFixed(4)}/${row.limit_usd} (reserved ${reserved.toFixed(4)})`,
        };
      }
    }
  }
  return { ok: true, reservedUsd: reserved };
}

// ---------------------------------------------------------------------------
// OpenCode serial refusal (docs/adapters.md "Concurrency note", review round
// 1 F4). Off by default: the primary fix is `run:launch`'s per agent
// `XDG_DATA_HOME` isolation (`dataHome`); this is the backstop for an
// OpenCode version where that isolation is found not to hold.
// ---------------------------------------------------------------------------

/**
 * When `config.opencode_serial` is true and `adapterName` is `opencode`,
 * refuses if any task_runs row anywhere in the ledger is currently `running`
 * with `adapter = 'opencode'` (docs/adapters.md: "run:start refuses a
 * second concurrent OpenCode run on the same host with exit 6 and reason
 * opencode_serial"). Every other adapter, or the dial off, always passes.
 */
export function checkOpencodeSerial(db, config, adapterName) {
  if (!config.opencode_serial || adapterName !== 'opencode') return { ok: true, running: 0 };
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM task_runs WHERE status = 'running' AND adapter = 'opencode'")
    .get();
  return { ok: row.c === 0, running: row.c };
}

// ---------------------------------------------------------------------------
// Task state machine (docs/state-machine.md "Task states")
// ---------------------------------------------------------------------------

// `input_required` is reached only as the side effect of a halt escalation
// (see `escalate` below), never as a direct target of `transition` - a halt
// can happen from `submitted` (preflight, before run:start ever reaches
// `working`) or from `working`, and escalate() handles both by going
// straight to input_required rather than walking this graph.
const GRAPH = {
  // completed/failed from `submitted` covers task:close on a task that
  // never had a run at all (e.g. a research/ops task, or one closed as
  // already-done) - docs/state-machine.md's diagram only draws the
  // run:start path explicitly, but task:close's own gate (docs/cli.md)
  // does not require a prior run to exist.
  submitted: ['working', 'completed', 'failed', 'canceled', 'rejected'],
  working: ['working', 'completed', 'failed', 'canceled'],
  input_required: ['working', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'rejected']);

function appendNote(existing, note) {
  if (!note) return existing;
  return existing ? `${existing}; ${note}` : note;
}

/**
 * Move a task to `toStatus`, enforcing the state graph above. Throws an
 * Error with `.code = 6` on an illegal transition (docs/state-machine.md
 * exit code table), or `.code = 1` if the task does not exist.
 */
export function transition(db, taskId, toStatus, { note } = {}) {
  const task = getTask(db, taskId);
  if (!task) {
    const e = new Error(`no such task: ${taskId}`);
    e.code = 1;
    throw e;
  }
  const allowed = GRAPH[task.status] ?? [];
  if (!allowed.includes(toStatus)) {
    const e = new Error(`illegal transition: task ${taskId} is ${task.status}, cannot move to ${toStatus}`);
    e.code = 6;
    throw e;
  }
  setTaskStatus(db, taskId, toStatus);
  if (note) {
    db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(appendNote(task.notes, note), taskId);
  }
  return getTask(db, taskId);
}

// ---------------------------------------------------------------------------
// Escalations (docs/ledger.md "escalations", docs/state-machine.md)
// ---------------------------------------------------------------------------

/**
 * Insert an escalation row. A `halt` severity moves the task straight to
 * `input_required` (unless the task is already in a terminal state, in
 * which case the escalation is recorded but the status is left alone - a
 * closed task cannot be un-closed by a late guard finding). `warn` never
 * changes task state.
 */
export function escalate(db, { taskId, runId, reason, severity = 'halt', detail } = {}) {
  const escalation = insertEscalation(db, {
    task_id: taskId,
    run_id: runId,
    reason,
    severity,
    detail,
  });
  if (severity === 'halt') {
    const task = getTask(db, taskId);
    if (task && !TERMINAL_STATUSES.has(task.status)) {
      setTaskStatus(db, taskId, 'input_required');
    }
  }
  return escalation;
}

/**
 * task:resolve: close out every open `halt` escalation on the task, log a
 * human_interventions row (kind `retry_authorized` when authorizing another
 * builder attempt, `note` otherwise), and move the task back to `working`.
 */
export function resolveEscalations(db, taskId, { note, retryAuthorized = false } = {}) {
  const now = nowIso();
  const openHalts = db
    .prepare("SELECT * FROM escalations WHERE task_id = ? AND severity = 'halt' AND resolved_at IS NULL")
    .all(taskId);
  const update = db.prepare('UPDATE escalations SET resolved_at = ?, resolution = ? WHERE id = ?');
  for (const esc of openHalts) {
    update.run(now, note ?? 'resolved', esc.id);
  }
  insertIntervention(db, {
    task_id: taskId,
    kind: retryAuthorized ? 'retry_authorized' : 'note',
    detail: note ?? null,
  });
  transition(db, taskId, 'working');
  return { resolved: openHalts.length };
}

// ---------------------------------------------------------------------------
// Retroactive wall clock (docs/state-machine.md "Wall clock watchdog")
// ---------------------------------------------------------------------------

/**
 * If the watchdog process itself died, `run:end` calls this to apply the
 * wall clock rule after the fact: if the run is still `running` in the
 * ledger and more time has elapsed than its wall clock limit, halt it here
 * instead of trusting a watchdog that never got the chance to.
 */
export function retroactiveWallclock(db, config, run, now = new Date()) {
  if (run.status !== 'running') return { fired: false };
  const limitS = run.wallclock_limit_s ?? config.limits.wallclock_s;
  const startedMs = Date.parse(run.started_at);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const elapsedS = (nowMs - startedMs) / 1000;
  if (elapsedS <= limitS) return { fired: false };

  db.prepare(
    "UPDATE task_runs SET status = 'halted', halted_reason = 'wallclock', ended_at = ? WHERE id = ?"
  ).run(nowIso(), run.id);
  escalate(db, {
    taskId: run.task_id,
    runId: run.id,
    reason: 'wallclock',
    severity: 'halt',
    detail: `elapsed ${elapsedS.toFixed(0)}s exceeds limit ${limitS}s (retroactive, watchdog absent)`,
  });
  return { fired: true, elapsedS };
}
