// Migrating a database created by the original 000-base.sql only, with
// legacy status values, per docs/ledger.md "Migrations" and the wave todo's
// hard constraint: "migration must be idempotent and must convert the
// legacy open|done|halted statuses exactly as docs/ledger.md says."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, migrate } from '../src/db.mjs';
import { makeTempDb } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_SCHEMA_PATH = join(HERE, '..', 'src', 'schema', '000-base.sql');

function insertLegacyTask(db, { id, status, outcome = null }) {
  db.prepare(
    `INSERT INTO tasks (id, created_at, repo, issue_number, title, task_class, arm, status, outcome, human_edits)
     VALUES (?, '2026-01-01T00:00:00.000Z', 'owner/repo', NULL, 'legacy task', 'ci', 'control', ?, ?, 0)`
  ).run(id, status, outcome);
}

function insertLegacyRun(db, { id, taskId }) {
  db.prepare(
    `INSERT INTO task_runs (id, task_id, seq, agent, provider, model, started_at)
     VALUES (?, ?, 1, 'builder', 'anthropic', 'claude-x', '2026-01-01T00:00:00.000Z')`
  ).run(id, taskId);
}

function makeLegacyDb() {
  const db = openDb(makeTempDb());
  db.exec(readFileSync(BASE_SCHEMA_PATH, 'utf8'));
  return db;
}

test('migration: legacy status rewrite matches docs/ledger.md exactly', async () => {
  const db = makeLegacyDb();

  // No schema_migrations table at all yet - this is exactly the "Phase 1
  // pilot database" scenario docs/ledger.md describes.
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(),
    undefined
  );

  insertLegacyTask(db, { id: 'legacy-open-no-runs', status: 'open' });
  insertLegacyTask(db, { id: 'legacy-open-with-run', status: 'open' });
  insertLegacyRun(db, { id: 'legacy-run-1', taskId: 'legacy-open-with-run' });
  insertLegacyTask(db, { id: 'legacy-halted', status: 'halted' });
  insertLegacyTask(db, { id: 'legacy-done-first-pass', status: 'done', outcome: 'first_pass' });
  insertLegacyTask(db, { id: 'legacy-done-revised', status: 'done', outcome: 'revised' });
  insertLegacyTask(db, { id: 'legacy-done-failed', status: 'done', outcome: 'failed' });
  insertLegacyTask(db, { id: 'legacy-done-abandoned', status: 'done', outcome: 'abandoned' });
  insertLegacyTask(db, { id: 'legacy-done-no-outcome', status: 'done', outcome: null });

  await migrate(db);

  const statusOf = (id) => db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status;

  assert.equal(statusOf('legacy-open-no-runs'), 'submitted');
  assert.equal(statusOf('legacy-open-with-run'), 'working');
  assert.equal(statusOf('legacy-halted'), 'input_required');
  assert.equal(statusOf('legacy-done-first-pass'), 'completed');
  assert.equal(statusOf('legacy-done-revised'), 'completed');
  assert.equal(statusOf('legacy-done-failed'), 'failed');
  assert.equal(statusOf('legacy-done-abandoned'), 'canceled');
  assert.equal(statusOf('legacy-done-no-outcome'), 'completed');

  // New columns exist and are backfilled sanely for pre-existing rows.
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('legacy-open-no-runs');
  assert.equal(row.kind, 'implement');
  assert.equal(row.priority, 3);
  assert.equal(row.owner, null);
  assert.equal(row.defects_escaped, 0);

  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.deepEqual(versions, ['000-base', '001-v01-tables', '002-v01-columns', '003-v02-autonomy', '004-v02-run-adapter', '005-v02-pr-capture', '006-v02-quota-reserve', '007-v02-provider-and-verdict', '008-v02-prompt-delivery', '009-v02-archive']);

  db.close();
});

test('migration: running migrate twice on a migrated legacy db is a no-op', async () => {
  const db = makeLegacyDb();
  insertLegacyTask(db, { id: 'a', status: 'done', outcome: 'first_pass' });
  insertLegacyTask(db, { id: 'b', status: 'halted' });

  const firstApplied = await migrate(db);
  assert.deepEqual(firstApplied, ['000-base', '001-v01-tables', '002-v01-columns', '003-v02-autonomy', '004-v02-run-adapter', '005-v02-pr-capture', '006-v02-quota-reserve', '007-v02-provider-and-verdict', '008-v02-prompt-delivery', '009-v02-archive']);

  const statusesAfterFirst = db.prepare('SELECT id, status FROM tasks ORDER BY id').all();

  const secondApplied = await migrate(db);
  assert.deepEqual(secondApplied, [], 'second migrate() call should apply nothing');

  const statusesAfterSecond = db.prepare('SELECT id, status FROM tasks ORDER BY id').all();
  assert.deepEqual(statusesAfterSecond, statusesAfterFirst, 'statuses must not change on a re-run');

  const migrationRowCount = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
  assert.equal(migrationRowCount, 10);

  db.close();
});

test('migration: 000-base.sql is safe to re-apply directly to an existing legacy db', () => {
  // This is what makes migrate() safe to run against a database created by
  // the original schema.sql: 000-base.sql must use CREATE TABLE/INDEX IF
  // NOT EXISTS everywhere so re-running it is a pure no-op.
  const db = makeLegacyDb();
  insertLegacyTask(db, { id: 'x', status: 'open' });
  assert.doesNotThrow(() => db.exec(readFileSync(BASE_SCHEMA_PATH, 'utf8')));
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('x');
  assert.equal(row.status, 'open');
  db.close();
});
