// Real Phase 1a defect fix (retry directory reuse): `task_runs.attempt_
// evidence_dir` (TEXT, nullable) records where a run's own artifacts were
// archived to once a LATER attempt for the same (task, agent) reused this
// run's out dir - see `archivePriorAttempt` (src/adapters/spawn.mjs) and
// `launchAttempt` (src/commands/runs.mjs), and docs/state-machine.md
// "Provider unavailable". Set to `<outDir>/attempts/<this run's own id>/`
// on THIS run's own row, by the NEXT attempt, at the moment that next
// attempt archives this one's artifacts out of the shared out dir - never
// set by the run itself, since a run has no way to know yet whether a retry
// will ever follow it. `task:show` reports it when present so an operator
// (or `doctor`) can find a retried attempt's own exit.txt/events.jsonl
// (the actual 429 evidence) without knowing this naming convention by heart.
//
// Same idempotency pattern as every migration since 002-v01-columns.mjs:
// `ALTER TABLE ... ADD COLUMN` throws if the column already exists, so guard
// it with `PRAGMA table_info` and this file stays safe to import more than
// once.

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export function up(db) {
  if (!hasColumn(db, 'task_runs', 'attempt_evidence_dir')) {
    db.exec('ALTER TABLE task_runs ADD COLUMN attempt_evidence_dir TEXT');
  }
}
