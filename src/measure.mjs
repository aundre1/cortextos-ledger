// Measurement (docs/measurement.md): pairing the tri and control arms of a
// measured task, side-by-side comparison, aggregate reporting, and a hand
// written CSV/JSON export - zero dependencies, so no csv library.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getTask, listRuns, listVerdicts, listTests, listEscalations, sumCost } from './ledger.mjs';

const TABLES = [
  'tasks',
  'task_runs',
  'agent_messages',
  'artifacts',
  'review_verdicts',
  'test_results',
  'cost_usage',
  'escalations',
  'provider_quota',
  'human_interventions',
  'usage_snapshots',
];

// The timestamp column each table uses for --since filtering in exportTables.
const TIME_COLUMN = {
  tasks: 'created_at',
  task_runs: 'started_at',
  agent_messages: 'created_at',
  artifacts: 'created_at',
  review_verdicts: 'created_at',
  test_results: 'created_at',
  cost_usage: 'created_at',
  escalations: 'created_at',
  provider_quota: 'updated_at',
  human_interventions: 'created_at',
  usage_snapshots: 'created_at',
};

// ---------------------------------------------------------------------------
// Per-task field bundle (docs/measurement.md "Recorded per arm")
// ---------------------------------------------------------------------------

function elapsedSecondsOfRuns(runs) {
  return runs.reduce((sum, r) => {
    if (!r.started_at || !r.ended_at) return sum;
    return sum + (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000;
  }, 0);
}

function hasAdjudicateIntervention(db, taskId) {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM human_interventions WHERE task_id = ? AND kind = 'adjudicate'")
      .get(taskId).c > 0
  );
}

function interventionsOf(db, taskId) {
  return db.prepare('SELECT * FROM human_interventions WHERE task_id = ? ORDER BY created_at').all(taskId);
}

function costByModel(db, taskId) {
  return db
    .prepare(
      `SELECT provider, model, SUM(cost_usd) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
       FROM cost_usage WHERE task_id = ? GROUP BY provider, model`
    )
    .all(taskId);
}

/**
 * One arm's measurement bundle. `unadjudicated` follows docs/measurement.md
 * "compare": the tri arm is unadjudicated when its latest verdict has no
 * findings_real yet (or there is no verdict at all); the control arm, which
 * has no verdict, is unadjudicated when no human_interventions row of kind
 * 'adjudicate' exists for it.
 */
function armBundle(db, task) {
  const runs = listRuns(db, task.id);
  const buildRuns = runs.filter((r) => r.agent === 'builder' || r.agent === 'solo');
  const verdicts = listVerdicts(db, task.id);
  const latestVerdict = verdicts.length ? verdicts[verdicts.length - 1] : null;
  const tests = listTests(db, task.id);
  const firstTest = tests.length ? tests[0] : null;
  const escalations = listEscalations(db, task.id);
  const interventions = interventionsOf(db, task.id);

  const unadjudicated =
    task.arm === 'control' ? !hasAdjudicateIntervention(db, task.id) : !latestVerdict || latestVerdict.findings_real == null;

  return {
    task_id: task.id,
    arm: task.arm,
    outcome: task.outcome,
    first_pass_success: firstTest ? firstTest.status === 'pass' && task.human_edits === 0 : null,
    revision_count: Math.max(buildRuns.length - 1, 0),
    reviewer_findings_real: latestVerdict ? latestVerdict.findings_real : null,
    reviewer_findings_noise: latestVerdict ? latestVerdict.findings_noise : null,
    defects_escaped: task.defects_escaped ?? 0,
    cost_by_model: costByModel(db, task.id),
    total_cost_usd: sumCost(db, task.id),
    elapsed_s: elapsedSecondsOfRuns(runs),
    human_interventions: interventions.map((h) => ({ kind: h.kind, minutes: h.minutes, detail: h.detail })),
    guard_firings: escalations.map((e) => ({ reason: e.reason, severity: e.severity })),
    unadjudicated,
  };
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

function findSiblingPair(db, { issue, pr, task }) {
  let anchor = null;
  if (task) anchor = getTask(db, task);
  else if (issue !== undefined && issue !== null) {
    anchor = db.prepare('SELECT * FROM tasks WHERE issue_number = ? ORDER BY created_at').get(issue);
  } else if (pr !== undefined && pr !== null) {
    anchor = db.prepare('SELECT * FROM tasks WHERE pr_number = ? ORDER BY created_at').get(pr);
  }
  if (!anchor) return null;

  if (anchor.sibling_id) {
    const sibling = getTask(db, anchor.sibling_id);
    if (sibling) return anchor.arm === 'tri' ? [anchor, sibling] : [sibling, anchor];
  }

  // Fall back to same repo + issue/pr number with both arms present.
  const column = issue !== undefined && issue !== null ? 'issue_number' : pr !== undefined && pr !== null ? 'pr_number' : null;
  const value = column === 'issue_number' ? anchor.issue_number : column === 'pr_number' ? anchor.pr_number : null;
  if (column && value != null) {
    const rows = db
      .prepare(`SELECT * FROM tasks WHERE repo = ? AND ${column} = ?`)
      .all(anchor.repo, value);
    const tri = rows.find((t) => t.arm === 'tri');
    const control = rows.find((t) => t.arm === 'control');
    if (tri && control) return [tri, control];
  }

  return null;
}

/**
 * Tri versus control (docs/measurement.md "Commands"). Refuses a winner
 * when either arm is unadjudicated - prints 'unadjudicated' instead, per
 * the doc.
 */
export function compare(db, config, { issue, pr, task } = {}) {
  const pair = findSiblingPair(db, { issue, pr, task });
  if (!pair) {
    return { ok: false, reason: 'no linked tri/control pair found', tri: null, control: null };
  }
  const [triTask, controlTask] = pair;
  const tri = armBundle(db, triTask);
  const control = armBundle(db, controlTask);

  if (tri.unadjudicated || control.unadjudicated) {
    return { ok: true, tri, control, reading: 'unadjudicated', winner: null };
  }

  const winner = tri.defects_escaped <= control.defects_escaped ? 'tri' : 'control';
  const loser = winner === 'tri' ? control : tri;
  const winnerBundle = winner === 'tri' ? tri : control;
  const costMultiple = loser.total_cost_usd > 0 ? winnerBundle.total_cost_usd / loser.total_cost_usd : null;
  const timeMultiple = loser.elapsed_s > 0 ? winnerBundle.elapsed_s / loser.elapsed_s : null;

  const reading = `${winner} arm had ${winnerBundle.defects_escaped} escaped defects versus ${loser.defects_escaped}, at ${costMultiple != null ? costMultiple.toFixed(2) : '?'}x cost and ${timeMultiple != null ? timeMultiple.toFixed(2) : '?'}x time`;

  return { ok: true, tri, control, reading, winner };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const ADJUDICATED_THRESHOLD = 20;

function tasksForReport(db, { taskClass, since }) {
  const clauses = [];
  const params = [];
  if (taskClass) {
    clauses.push('task_class = ?');
    params.push(taskClass);
  }
  if (since) {
    clauses.push('created_at >= ?');
    params.push(since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM tasks ${where}`).all(...params);
}

/**
 * Per-class statistics (docs/measurement.md "report"). Any class with fewer
 * than 20 adjudicated runs is marked 'n < 20, not routing grade' rather than
 * silently reported as if it were reliable.
 */
export function report(db, config, { taskClass, since, guards, reviewers } = {}) {
  const tasks = tasksForReport(db, { taskClass, since });
  const byClass = new Map();
  for (const t of tasks) {
    if (!byClass.has(t.task_class)) byClass.set(t.task_class, []);
    byClass.get(t.task_class).push(t);
  }

  const classes = [...byClass.entries()].map(([taskClassName, classTasks]) => {
    const bundles = classTasks.map((t) => armBundle(db, t));
    const adjudicated = bundles.filter((b) => !b.unadjudicated);
    const byArm = (arm) => bundles.filter((b) => b.arm === arm);
    const firstPassRate = (arm) => {
      const armBundles = byArm(arm).filter((b) => b.first_pass_success != null);
      if (!armBundles.length) return null;
      return armBundles.filter((b) => b.first_pass_success).length / armBundles.length;
    };
    const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

    return {
      task_class: taskClassName,
      count: classTasks.length,
      adjudicated_count: adjudicated.length,
      not_routing_grade: adjudicated.length < ADJUDICATED_THRESHOLD,
      first_pass_rate: { tri: firstPassRate('tri'), control: firstPassRate('control') },
      mean_cost_usd: { tri: mean(byArm('tri').map((b) => b.total_cost_usd)), control: mean(byArm('control').map((b) => b.total_cost_usd)) },
      mean_elapsed_s: { tri: mean(byArm('tri').map((b) => b.elapsed_s)), control: mean(byArm('control').map((b) => b.elapsed_s)) },
    };
  });

  const result = { classes };

  if (reviewers) {
    // Precision per provider/task class: sum(findings_real)/sum(findings_total) over adjudicated verdicts.
    const rows = db
      .prepare(
        `SELECT v.provider AS provider, t.task_class AS task_class, v.findings_real AS findings_real, v.findings_total AS findings_total
         FROM review_verdicts v JOIN tasks t ON t.id = v.task_id
         WHERE v.findings_real IS NOT NULL`
      )
      .all();
    const byKey = new Map();
    for (const r of rows) {
      const key = `${r.provider}::${r.task_class}`;
      const acc = byKey.get(key) ?? { provider: r.provider, task_class: r.task_class, real: 0, total: 0 };
      acc.real += r.findings_real ?? 0;
      acc.total += r.findings_total ?? 0;
      byKey.set(key, acc);
    }
    result.reviewer_precision = [...byKey.values()].map((r) => ({
      ...r,
      precision: r.total > 0 ? r.real / r.total : null,
    }));
  }

  if (guards) {
    const rows = db.prepare('SELECT reason, COUNT(*) AS c FROM escalations GROUP BY reason ORDER BY reason').all();
    result.guard_firings = rows.map((r) => ({ reason: r.reason, count: r.c }));
  }

  return result;
}

// ---------------------------------------------------------------------------
// exportTables
// ---------------------------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * One file per table (docs/measurement.md "export"). CSV escaping is hand
 * written (no dependency): fields containing a comma, quote, or newline are
 * wrapped in double quotes with internal quotes doubled, per RFC 4180.
 */
export function exportTables(db, { format = 'csv', table, since, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const tables = table ? [table] : TABLES;
  const files = [];

  for (const t of tables) {
    if (!TABLES.includes(t)) throw new Error(`unknown table: ${t}`);
    const timeColumn = TIME_COLUMN[t];
    let rows;
    if (since && timeColumn) {
      rows = db.prepare(`SELECT * FROM ${t} WHERE ${timeColumn} >= ? ORDER BY ${timeColumn}`).all(since);
    } else {
      rows = db.prepare(`SELECT * FROM ${t}`).all();
    }
    const ext = format === 'json' ? 'json' : 'csv';
    const path = join(outDir, `${t}.${ext}`);
    const content = format === 'json' ? JSON.stringify(rows, null, 2) : rowsToCsv(rows);
    writeFileSync(path, content);
    files.push(path);
  }

  return { files };
}
