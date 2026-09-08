// v0.2 addition (Phase 1a real-batch fixes, F1/F2): the live Phase 1a batch
// (16 runs, zero stored verdicts) surfaced two gaps this migration closes:
//
// - `task_runs.failure_class` (F1): 12 of those 16 runs failed with the
//   run's out.txt containing exactly one line, a normalized `error` event
//   reporting a provider 429 ("Too Many Requests") - an ordinary `fail`
//   status counted the run against `builder_attempts_max`/the challenge
//   cycle count exactly like a genuine agent mistake would. `run:end`
//   (src/commands/runs.mjs) now classifies a run whose events.jsonl stream
//   ended with a terminal retryable `error` event and no successful
//   completion as `failure_class = 'provider_unavailable'`
//   (src/guards/postrun.mjs classifyFailureClass); `checkAttempts`
//   (src/limits.mjs) excludes such runs from the attempt count (see
//   docs/state-machine.md "Attempt counting"). Values: `null` (the default,
//   every ordinary run) or `'provider_unavailable'` - room is left for more
//   values later, per this task's own instructions ("leave room for more").
//
// - `review_verdicts.summary_truncated_from` (F2): three real verdicts from
//   a single Phase 1a dry-run reviewer model each exceeded the documented
//   600 character `summary` cap (754, 937, 967 characters) and were
//   rejected outright by `cortexctl verdict` (exit 5) - every finding in
//   each verdict was lost over prose length alone. `storeVerdict`
//   (src/review.mjs) now truncates an over-length `summary` at a word
//   boundary to the documented cap and stores the verdict (every other
//   validation rule still exits 5 exactly as before); this column records
//   the original, pre-truncation length so the ledger shows truncation
//   happened, `null` when it did not.
//
// Same idempotency pattern as every migration since 002-v01-columns.mjs:
// `ALTER TABLE ... ADD COLUMN` throws if the column already exists, so guard
// it with `PRAGMA table_info` and this file stays safe to import more than
// once.

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function up(db) {
  addColumnIfMissing(db, 'task_runs', 'failure_class', 'TEXT');
  addColumnIfMissing(db, 'review_verdicts', 'summary_truncated_from', 'INTEGER');
}
