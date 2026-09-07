// v0.2 addition (task E1-1, PR capture on task:new): `tasks.pr_repo`,
// `tasks.base_sha`, `tasks.head_sha` record the `owner/name` a `pr_review`
// task's pull request lives in and the two commit shas `gh pr view`
// reports (`baseRefOid`/`headRefOid`), so a task can be compared against the
// PR it was opened for without re-shelling out to `gh`.
//
// `tasks.pr_number` already exists (src/schema/002-v01-columns.mjs) - only
// these three columns are new here. Same idempotency pattern as
// 002-v01-columns.mjs/004-v02-run-adapter.mjs: `ALTER TABLE ... ADD COLUMN`
// throws if the column already exists, so guard it with `PRAGMA table_info`
// and this file stays safe to import more than once.

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const TASKS_COLUMNS = [
  ['pr_repo', 'TEXT'],
  ['base_sha', 'TEXT'],
  ['head_sha', 'TEXT'],
];

export function up(db) {
  for (const [column, definition] of TASKS_COLUMNS) {
    addColumnIfMissing(db, 'tasks', column, definition);
  }
}
