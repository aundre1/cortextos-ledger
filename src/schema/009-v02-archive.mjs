// Blocker 2 (owner's explicit instruction): `purge --task <id> --confirm`
// deleted a task and its rows outright - work must be ARCHIVED for later
// retrieval, never deleted. `task:archive`/`task:unarchive`
// (src/commands/tasks.mjs) set/clear these two columns; nothing in this kit
// ever deletes a tasks row on account of archiving (`purge` still exists,
// deletes irreversibly, and now refuses outright unless the task is already
// archived - docs/cli.md "purge").
//
// `tasks.archived_at` (TEXT, nullable, ISO 8601 UTC): when set, the task is
// excluded from `board`, from `compare`, from `report`, and from every
// precision/cost statistic report computes - exactly the same treatment an
// unadjudicated task already gets from those commands (docs/measurement.md
// "Recorded per arm"/"report"). `task:show` and `export` are unaffected:
// both always include an archived task, `task:show` saying plainly that it
// is archived and why, `export` carrying `archived_at`/`archive_reason`
// straight through its `SELECT *` per table dump - nothing is ever removed
// from the record.
//
// `tasks.archive_reason` (TEXT, nullable): the free-text reason given to
// `task:archive --reason "..."`, carried alongside `archived_at`.
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
  addColumnIfMissing(db, 'tasks', 'archived_at', 'TEXT');
  addColumnIfMissing(db, 'tasks', 'archive_reason', 'TEXT');
}
