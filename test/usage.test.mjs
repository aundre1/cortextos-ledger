import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, migrate } from '../src/db.mjs';
import { makeTempDb } from './helpers.mjs';
import { snapshot, delta } from '../src/usage.mjs';

async function migratedDb() {
  const db = openDb(makeTempDb());
  await migrate(db);
  return db;
}

test('snapshot: wraps insertSnapshot with the u_ prefix and stored fields', async () => {
  const db = await migratedDb();
  const row = snapshot(db, {
    provider: 'anthropic', plan: 'claude-max-5x', window_kind: '5h', used_pct: 42, phase: 'start', task_id: null,
  });
  assert.match(row.id, /^u_/);
  const stored = db.prepare('SELECT * FROM usage_snapshots WHERE id = ?').get(row.id);
  assert.equal(stored.provider, 'anthropic');
  assert.equal(stored.used_pct, 42);
  assert.equal(stored.phase, 'start');
  db.close();
});

test('delta: computes end - start per provider from bracketing snapshots', async () => {
  const db = await migratedDb();
  const taskId = 't_fake123456789012345678901';
  snapshot(db, { provider: 'anthropic', plan: 'claude-max-5x', window_kind: '5h', used_pct: 10, task_id: taskId, phase: 'start' });
  snapshot(db, { provider: 'opencode-go', plan: 'opencode-go', window_kind: '5h', used_pct: 5, task_id: taskId, phase: 'start' });
  snapshot(db, { provider: 'anthropic', plan: 'claude-max-5x', window_kind: '5h', used_pct: 37, task_id: taskId, phase: 'end' });

  const result = delta(db, taskId);
  assert.equal(result.anthropic.start_pct, 10);
  assert.equal(result.anthropic.end_pct, 37);
  assert.equal(result.anthropic.delta_pct, 27);

  // opencode-go only has a start snapshot: end and delta are null, not a
  // dropped provider.
  assert.equal(result['opencode-go'].start_pct, 5);
  assert.equal(result['opencode-go'].end_pct, null);
  assert.equal(result['opencode-go'].delta_pct, null);
  db.close();
});

test('delta: a task with no snapshots returns an empty object', async () => {
  const db = await migratedDb();
  const result = delta(db, 't_nonexistent000000000000000');
  assert.deepEqual(result, {});
  db.close();
});

test('delta: uses the earliest start and the latest end when there are several of each', async () => {
  const db = await migratedDb();
  const taskId = 't_multi1234567890123456789012';
  snapshot(db, { provider: 'google', plan: 'x', window_kind: 'day', used_pct: 50, task_id: taskId, phase: 'start' });
  snapshot(db, { provider: 'google', plan: 'x', window_kind: 'day', used_pct: 60, task_id: taskId, phase: 'start' }); // a later, ignored 'start'
  snapshot(db, { provider: 'google', plan: 'x', window_kind: 'day', used_pct: 80, task_id: taskId, phase: 'end' });
  snapshot(db, { provider: 'google', plan: 'x', window_kind: 'day', used_pct: 95, task_id: taskId, phase: 'end' }); // latest 'end' wins

  const result = delta(db, taskId);
  assert.equal(result.google.start_pct, 50);
  assert.equal(result.google.end_pct, 95);
  assert.equal(result.google.delta_pct, 45);
  db.close();
});
