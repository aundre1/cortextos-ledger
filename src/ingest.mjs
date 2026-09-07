// Replay a run's normalized events.jsonl into the ledger and quota
// (docs/cli.md "ingest": "Replay normalized events into the ledger and
// quota"). Never reads the adapters (docs/adapters.md: "An adapter ...
// never reads the ledger" - the arrow only ever points the other way,
// ingest reading what an adapter or the OpenCode plugin wrote).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertArtifact, insertCost, sumCost } from './ledger.mjs';
import { redact } from './adapters/credential-boundary.mjs';
import { rollQuota, tickQuota } from './quota.mjs';
import { escalate } from './limits.mjs';

const SUMMARY_MAX = 300;

// docs/guards.md "Missing artifacts" / docs/ledger.md "artifacts" kind list:
// the well-known files a run's out_dir may contain, and the artifact kind
// each becomes.
const ARTIFACT_FILES = [
  ['patch.diff', 'diff'],
  ['reasoning.md', 'reasoning'],
  ['verdict.json', 'review'],
  ['out.txt', 'stdout'],
];

function parseEventsFile(eventsPath) {
  let text;
  try {
    text = readFileSync(eventsPath, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Malformed line (a truncated write from a killed process, most
      // likely): skip it rather than fail the whole ingest.
    }
  }
  return events;
}

function getRunRow(db, runId) {
  return db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) ?? null;
}

function priorPluginCostRow(db, runId) {
  return db
    .prepare("SELECT requests, cost_usd FROM cost_usage WHERE run_id = ? AND source = 'plugin'")
    .get(runId);
}

function artifactAlreadyRecorded(db, runId, kind) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM artifacts WHERE run_id = ? AND kind = ?').get(runId, kind);
  return row.c > 0;
}

function hasOpenBudgetEscalation(db, taskId) {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM escalations WHERE task_id = ? AND reason = 'budget' AND resolved_at IS NULL")
    .get(taskId);
  return row.c > 0;
}

/**
 * ingest(db, config, { eventsPath, taskId, runId }) -> summary object.
 *
 * Idempotent: calling this twice for the same run does not duplicate the
 * `cost_usage` row (the prior `source = 'plugin'` row for this run is
 * deleted and reinserted), does not duplicate artifacts (skipped once a
 * kind is already recorded for the run), does not double-tick quota (only
 * the delta from the previous plugin-sourced cost row is applied), and does
 * not raise a second `budget` escalation for the same task while one is
 * still open.
 */
export function ingest(db, config, { eventsPath, taskId, runId }) {
  const run = getRunRow(db, runId);
  if (!run) throw new Error(`run not found: ${runId}`);

  const events = parseEventsFile(eventsPath);

  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let toolCalls = 0;
  let messageCount = 0;
  let sessionId = run.session_id ?? null;
  let exitCode = run.exit_code ?? null;
  let sessionEndRequests = null;
  let lastAssistantText = null;

  for (const event of events) {
    switch (event.type) {
      case 'session.start':
        if (event.session_id) sessionId = event.session_id;
        break;

      case 'tool.call':
        toolCalls++;
        break;

      case 'message':
        messageCount++;
        tokensIn += event.tokens_in ?? 0;
        tokensOut += event.tokens_out ?? 0;
        costUsd += event.cost_usd ?? 0;
        if (event.role === 'assistant') {
          const text = event.text ?? event.result_excerpt ?? event.summary ?? null;
          if (typeof text === 'string' && text.length) lastAssistantText = text;
        }
        break;

      case 'session.end':
        if (event.session_id) sessionId = event.session_id;
        if (typeof event.exit_code === 'number') exitCode = event.exit_code;
        if (typeof event.requests === 'number') sessionEndRequests = event.requests;
        if (typeof event.result_excerpt === 'string' && event.result_excerpt.length) {
          lastAssistantText = event.result_excerpt;
        }
        // A harness that only reports usage once, at the very end (Codex -
        // docs/adapters.md), would otherwise leave the per-message sum at
        // zero; take whichever of the two tallies is larger.
        tokensIn = Math.max(tokensIn, event.tokens_in ?? 0);
        tokensOut = Math.max(tokensOut, event.tokens_out ?? 0);
        costUsd = Math.max(costUsd, event.cost_usd ?? 0);
        break;

      default:
        break;
    }
  }

  // "requests (count of message events, or session.end requests if present)"
  const requests = sessionEndRequests ?? messageCount;
  const summary = lastAssistantText ? redact(lastAssistantText).slice(0, SUMMARY_MAX) : run.summary ?? null;
  const now = new Date().toISOString();
  const status =
    run.status === 'running' ? (exitCode === 0 ? 'ok' : exitCode == null ? run.status : 'fail') : run.status;

  db.prepare(
    `UPDATE task_runs
       SET tokens_in = ?, tokens_out = ?, cost_usd = ?, tool_calls = ?, session_id = ?,
           summary = ?, ended_at = ?, status = ?, exit_code = COALESCE(exit_code, ?)
     WHERE id = ?`
  ).run(tokensIn, tokensOut, costUsd, toolCalls, sessionId, summary, now, status, exitCode, runId);

  // cost_usage: one 'plugin' sourced row per run, replaced on every ingest so
  // this stays idempotent. The delta against whatever the prior plugin row
  // held (zero, the first time) is what actually gets ticked against quota
  // below, so re-ingesting the same file twice never double-counts usage.
  const prior = priorPluginCostRow(db, runId);
  db.prepare("DELETE FROM cost_usage WHERE run_id = ? AND source = 'plugin'").run(runId);
  insertCost(db, {
    task_id: taskId,
    run_id: runId,
    provider: run.provider,
    model: run.model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
    requests,
    source: 'plugin',
  });

  const deltaRequests = requests - (prior?.requests ?? 0);
  const deltaUsd = costUsd - (prior?.cost_usd ?? 0);

  rollQuota(db, new Date());
  if (deltaRequests !== 0 || deltaUsd !== 0) {
    tickQuota(db, { provider: run.provider, model: run.model, requests: deltaRequests, usd: deltaUsd });
  }

  // Artifacts: only the well-known files, only when present on disk, and
  // only once per (run, kind) - a second ingest of the same run must not
  // insert a duplicate row for a file that has not changed.
  const artifactsInserted = [];
  if (run.out_dir) {
    for (const [file, kind] of ARTIFACT_FILES) {
      const filePath = join(run.out_dir, file);
      if (existsSync(filePath) && !artifactAlreadyRecorded(db, runId, kind)) {
        insertArtifact(db, { task_id: taskId, run_id: runId, kind, path: filePath });
        artifactsInserted.push(kind);
      }
    }
  }

  // Budget escalation: docs/state-machine.md "Spend per task" - at ingest,
  // actual spend over the limit halts the task. Fires once per task; a
  // second ingest (or a second run) that is still over budget does not pile
  // on more escalations while one is already open.
  let budgetEscalation = null;
  const totalSpend = sumCost(db, taskId);
  if (totalSpend > config.limits.spend_usd && !hasOpenBudgetEscalation(db, taskId)) {
    // escalate() from src/limits.mjs owns the halt -> input_required
    // semantics (and leaves a terminal task's status alone) - use it here
    // rather than re-implementing that rule with insertEscalation/
    // setTaskStatus directly (unified per the wave's cross-module seams).
    budgetEscalation = escalate(db, {
      taskId,
      runId,
      reason: 'budget',
      severity: 'halt',
      detail: `spend ${totalSpend.toFixed(4)} exceeds limit ${config.limits.spend_usd}`,
    });
  }

  return {
    run_id: runId,
    task_id: taskId,
    events: events.length,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
    requests,
    tool_calls: toolCalls,
    session_id: sessionId,
    status,
    artifacts: artifactsInserted,
    total_spend_usd: totalSpend,
    budget_escalation_id: budgetEscalation ? budgetEscalation.id : null,
  };
}
