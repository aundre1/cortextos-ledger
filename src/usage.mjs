// Subscription usage snapshots and per-task deltas (docs/ledger.md
// "usage_snapshots"). Thin: insertSnapshot already applies the u_ prefix.

import { insertSnapshot, listSnapshots } from './ledger.mjs';

/** cortexctl usage:snapshot - records one point-in-time reading. */
export function snapshot(db, fields) {
  return insertSnapshot(db, fields);
}

/**
 * Per provider { start_pct, end_pct, delta_pct }, from the earliest 'start'
 * and latest 'end' snapshot bracketing a task. Either side is null when that
 * phase was never recorded for that provider, and delta_pct is then null too.
 */
export function delta(db, taskId) {
  const rows = listSnapshots(db, { taskId }); // ascending by created_at
  const byProvider = new Map();

  for (const row of rows) {
    if (!byProvider.has(row.provider)) {
      byProvider.set(row.provider, { start: null, end: null });
    }
    const entry = byProvider.get(row.provider);
    if (row.phase === 'start' && entry.start === null) entry.start = row; // earliest
    if (row.phase === 'end') entry.end = row; // latest (rows are ascending)
  }

  const result = {};
  for (const [provider, { start, end }] of byProvider) {
    const startPct = start ? start.used_pct : null;
    const endPct = end ? end.used_pct : null;
    result[provider] = {
      start_pct: startPct,
      end_pct: endPct,
      delta_pct: startPct != null && endPct != null ? endPct - startPct : null,
    };
  }
  return result;
}
