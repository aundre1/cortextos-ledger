import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { openDb, migrate, newId, nowIso, sql, dialects, pendingMigrations, schemaVersion } from '../src/db.mjs';
import { makeTempDb } from './helpers.mjs';

test('newId: shape, alphabet, uniqueness', () => {
  const id = newId('t');
  assert.match(id, /^t_[0-9A-HJKMNP-TV-Z]{26}$/, `id ${id} should be prefix_ + 26 Crockford base32 chars`);

  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(newId('t'));
  assert.equal(ids.size, 500, 'ids should not collide');
});

test('newId: time sortable at millisecond resolution', async () => {
  const first = newId('r');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = newId('r');
  assert.ok(second > first, 'a later id should sort after an earlier one');
});

test('nowIso: valid ISO 8601 UTC string close to now', () => {
  const before = Date.now();
  const iso = nowIso();
  const after = Date.now();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const parsed = Date.parse(iso);
  assert.ok(parsed >= before && parsed <= after);
});

test('sql: dialect map has exactly sqlite and postgres, both keys', () => {
  assert.deepEqual(Object.keys(dialects).sort(), ['postgres', 'sqlite']);
  assert.equal(sql('sqlite', 'insertIgnore'), 'INSERT OR IGNORE');
  assert.equal(sql('sqlite', 'conflictNothing'), '');
  assert.equal(sql('postgres', 'insertIgnore'), 'INSERT');
  assert.equal(sql('postgres', 'conflictNothing'), 'ON CONFLICT DO NOTHING');
  assert.throws(() => sql('mysql', 'insertIgnore'));
  assert.throws(() => sql('sqlite', 'nope'));
});

test('openDb: creates the file and parent directory, sets pragmas', () => {
  const path = makeTempDb();
  assert.ok(!existsSync(path));
  const db = openDb(path);
  assert.ok(existsSync(path));
  const fk = db.prepare('PRAGMA foreign_keys').get();
  assert.equal(Number(fk.foreign_keys), 1);
  const journal = db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');
  db.close();
});

test('migrate: fresh database gets every table and is idempotent', async () => {
  const db = openDb(makeTempDb());

  assert.deepEqual(pendingMigrations(db).map((m) => m.version), [
    '000-base',
    '001-v01-tables',
    '002-v01-columns',
    '003-v02-autonomy',
  ]);

  const applied = await migrate(db);
  assert.deepEqual(applied, ['000-base', '001-v01-tables', '002-v01-columns', '003-v02-autonomy']);
  assert.equal(schemaVersion(db), '003-v02-autonomy');
  assert.deepEqual(pendingMigrations(db), []);

  const tableNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const expected of [
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
    'schema_migrations',
    'proposals',
    'proposal_reviews',
    'lessons',
    'policy',
    'loop_ticks',
  ]) {
    assert.ok(tableNames.includes(expected), `expected table ${expected}`);
  }

  // New tasks columns exist.
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  for (const col of ['pr_number', 'kind', 'owner', 'priority', 'due_at', 'parent_id', 'worktree', 'defects_escaped']) {
    assert.ok(taskColumns.includes(col), `tasks should have column ${col}`);
  }

  // Running migrate again is a no-op: nothing pending, no error, same version.
  const secondApplied = await migrate(db);
  assert.deepEqual(secondApplied, []);
  assert.equal(schemaVersion(db), '003-v02-autonomy');

  const migrationRows = db.prepare('SELECT version FROM schema_migrations').all();
  assert.equal(migrationRows.length, 4);

  db.close();
});

test('migrate: init twice from the CLI is safe (smoke check via direct call)', async () => {
  const path = makeTempDb();
  const db1 = openDb(path);
  await migrate(db1);
  db1.close();

  const db2 = openDb(path);
  const applied = await migrate(db2);
  assert.deepEqual(applied, []);
  db2.close();
});
