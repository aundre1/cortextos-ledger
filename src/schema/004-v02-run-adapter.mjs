// v0.2 addition (review round 1, F4): `task_runs.adapter` records which
// adapter a run used ('fake' | 'claude' | 'codex' | 'opencode'), so
// `run:start` can enforce `opencode_serial` (refuse a second concurrent
// opencode run when the config dial says so, docs/adapters.md "Concurrency
// note") with a plain `WHERE status = 'running' AND adapter = 'opencode'`
// query instead of guessing an adapter from `agent`/`provider`, which are
// free text and not reliably one-to-one with an adapter.
//
// Same idempotency pattern as 002-v01-columns.mjs: `ALTER TABLE ... ADD
// COLUMN` throws if the column already exists, so guard it with
// `PRAGMA table_info` and this file stays safe to import more than once.

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export function up(db) {
  if (!hasColumn(db, 'task_runs', 'adapter')) {
    db.exec('ALTER TABLE task_runs ADD COLUMN adapter TEXT');
  }
}
