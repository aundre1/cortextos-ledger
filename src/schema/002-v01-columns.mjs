// v0.1 additions, part 2: ADD COLUMN steps for tables that already existed in
// 000-base.sql, plus the two indexes that depend on the new tasks columns,
// plus the legacy status rewrite (docs/ledger.md "Migrations").
//
// SQLite's `ALTER TABLE ... ADD COLUMN` throws if the column already exists,
// so every step here checks `PRAGMA table_info(<table>)` first. That makes
// this file safe to import and run more than once even outside the
// schema_migrations guard in src/db.mjs (which is the real idempotency
// guarantee: this version only ever runs once per database).
//
// The migration runner (src/db.mjs) applies .sql and .mjs files in filename
// order and calls this module's `up(db)` for this version.

/** True if `table` already has a column named `column`. */
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

/** ALTER TABLE ADD COLUMN, but only if the column is not already there. */
function addColumnIfMissing(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const TASKS_COLUMNS = [
  ['pr_number', 'INTEGER'],
  ['kind', "TEXT NOT NULL DEFAULT 'implement'"],
  ['owner', 'TEXT'],
  ['priority', 'INTEGER NOT NULL DEFAULT 3'],
  ['due_at', 'TEXT'],
  ['parent_id', 'TEXT REFERENCES tasks(id)'],
  ['worktree', 'TEXT'],
  ['defects_escaped', 'INTEGER NOT NULL DEFAULT 0'],
  // Fable arbitration 2026-09-07 (after A): the wave todo's OPEN QUESTION
  // under card A proposed a plain `sibling=<id>` note; arbitration overruled
  // that with a real column so `compare` (src/measure.mjs) can look up the
  // linked control/tri task directly instead of parsing notes text. The
  // `sibling=<id>` note is kept too, for backward compatibility with any
  // pilot-era tooling that reads notes.
  ['sibling_id', 'TEXT REFERENCES tasks(id)'],
];

const TASK_RUNS_COLUMNS = [
  ['worktree', 'TEXT'],
  ['out_dir', 'TEXT'],
  ['exit_code', 'INTEGER'],
  ['files_touched', 'INTEGER'],
  ['wallclock_limit_s', 'INTEGER'],
  ['halted_reason', 'TEXT'],
  ['pid', 'INTEGER'],
];

const REVIEW_VERDICTS_COLUMNS = [
  ['arm', 'TEXT'],
  ['challenge_seq', 'INTEGER NOT NULL DEFAULT 0'],
  ['tests_touched', 'INTEGER'],
  ['scope_exceeded', 'INTEGER'],
];

const COST_USAGE_COLUMNS = [['requests', 'INTEGER NOT NULL DEFAULT 0']];

const ESCALATIONS_COLUMNS = [
  ['run_id', 'TEXT'],
  ['severity', 'TEXT'],
];

/**
 * Rewrite legacy tasks.status values per docs/ledger.md:
 *   open   -> submitted (no runs yet) | working (has runs)
 *   halted -> input_required
 *   done   -> completed (outcome first_pass|revised)
 *           | failed    (outcome failed)
 *           | canceled  (outcome abandoned)
 *           | completed (any other/missing outcome; conservative fallback
 *             per the v0.1 task card, since "done" is otherwise terminal)
 */
function rewriteLegacyStatuses(db) {
  const legacy = db
    .prepare("SELECT id, status, outcome FROM tasks WHERE status IN ('open', 'done', 'halted')")
    .all();
  const runCountStmt = db.prepare('SELECT COUNT(*) AS c FROM task_runs WHERE task_id = ?');
  const updateStmt = db.prepare('UPDATE tasks SET status = ? WHERE id = ?');

  for (const task of legacy) {
    let next;
    if (task.status === 'open') {
      const runCount = runCountStmt.get(task.id).c;
      next = runCount > 0 ? 'working' : 'submitted';
    } else if (task.status === 'halted') {
      next = 'input_required';
    } else if (task.status === 'done') {
      if (task.outcome === 'first_pass' || task.outcome === 'revised') next = 'completed';
      else if (task.outcome === 'failed') next = 'failed';
      else if (task.outcome === 'abandoned') next = 'canceled';
      else next = 'completed';
    }
    if (next && next !== task.status) {
      updateStmt.run(next, task.id);
    }
  }
}

export function up(db) {
  for (const [column, definition] of TASKS_COLUMNS) {
    addColumnIfMissing(db, 'tasks', column, definition);
  }
  for (const [column, definition] of TASK_RUNS_COLUMNS) {
    addColumnIfMissing(db, 'task_runs', column, definition);
  }
  for (const [column, definition] of REVIEW_VERDICTS_COLUMNS) {
    addColumnIfMissing(db, 'review_verdicts', column, definition);
  }
  for (const [column, definition] of COST_USAGE_COLUMNS) {
    addColumnIfMissing(db, 'cost_usage', column, definition);
  }
  for (const [column, definition] of ESCALATIONS_COLUMNS) {
    addColumnIfMissing(db, 'escalations', column, definition);
  }

  // These two indexes need the tasks columns added above, so they cannot
  // live in 001-v01-tables.sql (which runs before this file).
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner_due ON tasks(owner, due_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)');

  rewriteLegacyStatuses(db);
}
