import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  openDb,
  migrate,
  newId,
  nowIso,
  sql,
  dialects,
  pendingMigrations,
  schemaVersion,
  withImmediateTransaction,
} from '../src/db.mjs';
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
    '004-v02-run-adapter',
    '005-v02-pr-capture',
    '006-v02-quota-reserve',
  ]);

  const applied = await migrate(db);
  assert.deepEqual(applied, [
    '000-base',
    '001-v01-tables',
    '002-v01-columns',
    '003-v02-autonomy',
    '004-v02-run-adapter',
    '005-v02-pr-capture',
    '006-v02-quota-reserve',
  ]);
  assert.equal(schemaVersion(db), '006-v02-quota-reserve');
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

  // PR capture columns (task E1-1): pr_repo, base_sha, head_sha.
  for (const col of ['pr_repo', 'base_sha', 'head_sha']) {
    assert.ok(taskColumns.includes(col), `tasks should have column ${col}`);
  }

  // task_runs.adapter (review round 1, F4: opencode_serial needs it).
  const runColumns = db.prepare('PRAGMA table_info(task_runs)').all().map((c) => c.name);
  assert.ok(runColumns.includes('adapter'), 'task_runs should have column adapter');

  // task_runs.quota_reserved (review round 3, F1(c)).
  assert.ok(runColumns.includes('quota_reserved'), 'task_runs should have column quota_reserved');

  // Running migrate again is a no-op: nothing pending, no error, same version.
  const secondApplied = await migrate(db);
  assert.deepEqual(secondApplied, []);
  assert.equal(schemaVersion(db), '006-v02-quota-reserve');

  const migrationRows = db.prepare('SELECT version FROM schema_migrations').all();
  assert.equal(migrationRows.length, 7);

  db.close();
});

// Blind review NF2 (medium): withImmediateTransaction's reentrant (depth > 1)
// branch never had a rollback path of its own - if some intermediate caller
// inside the outer transaction's own fn() caught a nested call's throw and
// swallowed it, the outer frame's own try/catch never saw anything wrong and
// committed the nested call's partial writes anyway. Primitive-level repro,
// exactly as the reviewer reported it: outer inserts row 1; a nested
// withImmediateTransaction call inserts row 2 then throws; an intermediate
// try/catch swallows that throw; outer inserts row 3 and returns normally.
test('withImmediateTransaction NF2: a nested failure swallowed by an intermediate try/catch still rolls back the whole outer transaction', () => {
  const db = openDb(makeTempDb());
  db.exec('CREATE TABLE nf2_rows (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = db.prepare('INSERT INTO nf2_rows (v) VALUES (?)');

  let outerThrew = null;
  try {
    withImmediateTransaction(db, () => {
      insert.run('row1');
      try {
        withImmediateTransaction(db, () => {
          insert.run('row2');
          throw new Error('nested boom');
        });
      } catch {
        // Intermediate caller swallows the nested failure - nothing here
        // rethrows, matching the reviewer's exact repro.
      }
      insert.run('row3');
      return 'outer result';
    });
  } catch (e) {
    outerThrew = e;
  }

  assert.ok(
    outerThrew,
    'the outer call must itself throw once it discovers the swallowed nested failure, instead of committing silently'
  );
  assert.match(
    outerThrew.message,
    /nested boom/,
    'the thrown error should name the swallowed inner failure so it is not silent'
  );

  const rows = db.prepare('SELECT * FROM nf2_rows').all();
  assert.equal(rows.length, 0, `zero rows should have persisted after the rollback, got ${JSON.stringify(rows)}`);

  db.close();
});

test('withImmediateTransaction NF2: a clean nested call still commits normally, and the failure marker does not leak into the next unrelated transaction', () => {
  const db = openDb(makeTempDb());
  db.exec('CREATE TABLE nf2_rows2 (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = db.prepare('INSERT INTO nf2_rows2 (v) VALUES (?)');

  // A normal, successful nested transaction commits both rows.
  const result = withImmediateTransaction(db, () => {
    insert.run('a');
    withImmediateTransaction(db, () => {
      insert.run('b');
    });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM nf2_rows2').get().c, 2);

  // A later, entirely separate transaction is unaffected by the earlier
  // rollback-and-throw path (the failure marker must reset between calls).
  withImmediateTransaction(db, () => {
    insert.run('c');
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM nf2_rows2').get().c, 3);

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
