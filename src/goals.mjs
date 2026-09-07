// Goals contract (docs/autonomy.md "Goals contract"): a private JSON file
// named by config.goals. loadGoals reads it (or returns an empty, flagged
// stand-in when missing); fillMetrics resolves `ledger:<report field>`
// sources from src/measure.mjs's report() output and computes each metric's
// gap; setMetric writes a manual metric's current value back to the file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { nowIso } from './db.mjs';
import { insertIntervention, ensureSyntheticTask } from './ledger.mjs';
import { report } from './measure.mjs';

const LEDGER_PREFIX = 'ledger:';

/**
 * Read config.goals. A missing file is not an error (docs: "A private
 * installation points config.goals at its own file, which never enters the
 * public repository") - it returns an empty contract with `missing: true`
 * and a `warning` string, rather than throwing.
 */
export function loadGoals(config) {
  const path = config.goals;
  if (!existsSync(path)) {
    return {
      goals_version: null,
      businesses: [],
      missing: true,
      warning: `goals file not found: ${path} (see examples/cortex-goals.example.json)`,
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`goals file is not valid JSON: ${path}: ${e.message}`);
  }
  return { goals_version: raw.goals_version ?? '1', businesses: raw.businesses ?? [], missing: false, warning: null };
}

// ---------------------------------------------------------------------------
// ledger:<field> resolution
// ---------------------------------------------------------------------------

/** Mean of the non-null values in `values`, or null when there are none. */
function mean(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Resolve one `ledger:report.<field>` metric source against a single
 * task_class's row in `report()`'s per-class output. Supported fields:
 * first_pass_rate (tri, falling back to control), reviewer_precision (mean
 * across providers for the class), cost_per_task, escaped_defects. Anything
 * else is unknown: current stays null with a note, per the task card.
 */
function resolveLedgerField(db, config, field, taskClass) {
  if (!taskClass) {
    return { current: null, note: `ledger source requires a metric task_class, got none for ${field}` };
  }
  const known = new Set(['first_pass_rate', 'reviewer_precision', 'cost_per_task', 'escaped_defects']);
  if (!known.has(field)) {
    return { current: null, note: `unknown ledger field: report.${field}` };
  }

  const withReviewers = field === 'reviewer_precision';
  const result = report(db, config, { taskClass, reviewers: withReviewers });
  const classRow = result.classes.find((c) => c.task_class === taskClass);
  if (!classRow) return { current: null, note: `no ledger data yet for task_class ${taskClass}` };

  if (field === 'first_pass_rate') {
    const current = classRow.first_pass_rate.tri ?? classRow.first_pass_rate.control ?? null;
    return { current, note: null };
  }
  if (field === 'cost_per_task') {
    return { current: classRow.cost_per_task ?? null, note: null };
  }
  if (field === 'escaped_defects') {
    return { current: classRow.escaped_defects ?? null, note: null };
  }
  // reviewer_precision: mean precision across providers for this task_class.
  const rows = (result.reviewer_precision ?? []).filter((r) => r.task_class === taskClass);
  return { current: mean(rows.map((r) => r.precision)), note: rows.length ? null : `no adjudicated verdicts yet for ${taskClass}` };
}

/**
 * Returns a deep copy of `goals` with every `ledger:<field>` metric's
 * `current` filled from src/measure.mjs's report() output, and a signed
 * `gap` (target minus current) added to every metric that has both a target
 * and a resolved current value.
 */
export function fillMetrics(db, config, goals) {
  const businesses = (goals.businesses ?? []).map((biz) => ({
    ...biz,
    metrics: (biz.metrics ?? []).map((metric) => {
      let current = metric.current ?? null;
      let note;
      if (typeof metric.source === 'string' && metric.source.startsWith(LEDGER_PREFIX)) {
        const field = metric.source.slice(LEDGER_PREFIX.length).replace(/^report\./, '');
        const resolved = resolveLedgerField(db, config, field, metric.task_class);
        current = resolved.current;
        note = resolved.note ?? undefined;
      }
      const gap = typeof metric.target === 'number' && typeof current === 'number' ? metric.target - current : null;
      return { ...metric, current, gap, ...(note ? { note } : {}) };
    }),
  }));
  return { ...goals, businesses };
}

// ---------------------------------------------------------------------------
// goals:set
// ---------------------------------------------------------------------------

/**
 * Update one manual metric's current value in the goals file on disk, and
 * record who did it (human_interventions kind 'note') against the business's
 * synthetic `_goals` task (human_interventions.task_id is NOT NULL, and a
 * goals edit is not necessarily about any one real task - docs/autonomy.md
 * "Synthetic task _proposals", applied the same way here).
 */
export function setMetric(db, config, { business, metric, current, by } = {}) {
  const path = config.goals;
  if (!existsSync(path)) {
    throw new Error(`goals file not found: ${path}; nothing to update`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const biz = (raw.businesses ?? []).find((b) => b.id === business);
  if (!biz) throw new Error(`no such business in goals file: ${business}`);
  const m = (biz.metrics ?? []).find((x) => x.name === metric);
  if (!m) throw new Error(`no such metric on business ${business}: ${metric}`);

  const before = m.current;
  m.current = current;
  m.updated_at = nowIso();
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');

  const task = ensureSyntheticTask(db, { businessId: business, name: '_goals', owner: biz.owner });
  const intervention = insertIntervention(db, {
    task_id: task.id,
    kind: 'note',
    detail: `goals:set business=${business} metric=${metric} current=${before ?? 'null'} -> ${current}${by ? ` by ${by}` : ''}`,
  });

  return { business, metric, before, after: current, intervention };
}
