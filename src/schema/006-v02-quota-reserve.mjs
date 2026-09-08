// Round 3 review fixes (F1, F3).
//
// F1(c): `task_runs.quota_reserved` (INTEGER, 0/1) marks a run whose
// `run:start` already reserved one unit of `provider_quota.used_requests`
// for it (src/commands/runs.mjs `doRunStart`, src/quota.mjs
// `reserveRequest`). `ingest` (src/ingest.mjs) reads this flag so it never
// adds a second +1 request for the same run from the real event count.
// Defaults to 0 so every pre-existing row, and every row a test or other
// code path inserts directly (bypassing `run:start`), keeps the prior
// ingest behaviour of ticking requests from the real event count.
//
// F3: `syncConfigQuota`'s (src/quota.mjs) find-or-insert was not atomic and
// had no lock, so N concurrent `quota:show`/`preflight`/`checkQuota` calls
// racing a never-before-seen (provider, model, window_kind) window could
// each read "no existing row" and each INSERT their own copy. This file:
//   1. Dedupes any provider_quota rows that already collide on (provider,
//      model, window_kind) - keeping the `source = 'manual'` row if one
//      exists in the group (an operator's `quota:set` always wins), else
//      the row with the earliest `updated_at` (first write wins), merging
//      `used_requests`/`used_usd` onto the kept row by taking the MAX
//      across the group (never silently lose usage that landed on a
//      duplicate).
//   2. Adds a UNIQUE index on `(provider, COALESCE(model, ''), window_kind)`
//      - a plain UNIQUE(provider, model, window_kind) would not work here
//      since SQLite (and Postgres) treat every NULL as distinct, and
//      `model` is NULL for a provider-wide window. This expression index
//      is supported identically by SQLite and Postgres, so no dialect map
//      entry is needed (docs/ledger.md "Postgres notes for v0.2").
//
// `syncConfigQuota` now does INSERT ... ON CONFLICT(provider,
// COALESCE(model, ''), window_kind) DO NOTHING against this index, inside
// withImmediateTransaction, so two concurrent callers race safely instead
// of duplicating rows.

function groupByKey(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.provider} ${row.model ?? ''} ${row.window_kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function dedupeProviderQuota(db) {
  const rows = db.prepare('SELECT * FROM provider_quota').all();
  const groups = groupByKey(rows);
  const del = db.prepare('DELETE FROM provider_quota WHERE id = ?');
  const merge = db.prepare('UPDATE provider_quota SET used_requests = ?, used_usd = ? WHERE id = ?');

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    let keep = group.find((r) => r.source === 'manual');
    if (!keep) {
      keep = group.reduce((oldest, r) => (r.updated_at < oldest.updated_at ? r : oldest), group[0]);
    }

    const mergedRequests = Math.max(...group.map((r) => r.used_requests ?? 0));
    const mergedUsd = Math.max(...group.map((r) => r.used_usd ?? 0));
    merge.run(mergedRequests, mergedUsd, keep.id);

    for (const row of group) {
      if (row.id !== keep.id) del.run(row.id);
    }
  }
}

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function up(db) {
  addColumnIfMissing(db, 'task_runs', 'quota_reserved', 'INTEGER NOT NULL DEFAULT 0');

  dedupeProviderQuota(db);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_unique ON provider_quota(provider, COALESCE(model, ''), window_kind)"
  );
}
