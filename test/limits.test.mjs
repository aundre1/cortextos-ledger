import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, migrate } from '../src/db.mjs';
import { makeTempDb } from './helpers.mjs';
import {
  insertTask,
  insertRun,
  insertIntervention,
  insertVerdict,
  insertCost,
  upsertQuota,
  listEscalations,
  getTask,
} from '../src/ledger.mjs';
import {
  checkAttempts,
  checkChallenge,
  projectedSpend,
  checkSpend,
  checkQuota,
  transition,
  escalate,
  resolveEscalations,
  retroactiveWallclock,
  computeBackoffMs,
} from '../src/limits.mjs';

const CONFIG = {
  limits: {
    builder_attempts_max: 3,
    challenge_cycles_max: 1,
    wallclock_s: 5400,
    spend_usd: 5.0,
    files_touched_max: 10,
    stall_s: 900,
  },
  providers: {
    nvidia: { windows: [{ kind: 'minute', limit_requests: 40 }], public_only: true },
  },
};

async function freshDb() {
  const db = openDb(makeTempDb());
  await migrate(db);
  return db;
}

test('checkAttempts: ok for the first three builder runs, refused on the fourth', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });

  for (let i = 0; i < 3; i++) {
    const check = checkAttempts(db, CONFIG, task.id, 'builder');
    assert.equal(check.ok, true, `attempt ${i + 1} should be allowed`);
    insertRun(db, { task_id: task.id, seq: i + 1, agent: 'builder', provider: 'fake', model: 'x' });
  }

  const fourth = checkAttempts(db, CONFIG, task.id, 'builder');
  assert.equal(fourth.ok, false);
  assert.equal(fourth.used, 3);
  assert.equal(fourth.max, 3);
  db.close();
});

test('checkAttempts: builder and solo share the same counter', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  insertRun(db, { task_id: task.id, seq: 1, agent: 'builder', provider: 'fake', model: 'x' });
  insertRun(db, { task_id: task.id, seq: 2, agent: 'solo', provider: 'fake', model: 'x' });
  const check = checkAttempts(db, CONFIG, task.id, 'solo');
  assert.equal(check.used, 2);
  db.close();
});

test('checkAttempts: retry_authorized human_interventions raises the ceiling by one', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  for (let i = 0; i < 3; i++) {
    insertRun(db, { task_id: task.id, seq: i + 1, agent: 'builder', provider: 'fake', model: 'x' });
  }
  assert.equal(checkAttempts(db, CONFIG, task.id, 'builder').ok, false);

  insertIntervention(db, { task_id: task.id, kind: 'retry_authorized', detail: 'one more try' });
  const raised = checkAttempts(db, CONFIG, task.id, 'builder');
  assert.equal(raised.ok, true);
  assert.equal(raised.max, 4);
  db.close();
});

test('checkAttempts: non-builder agents are never limited', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  for (let i = 0; i < 5; i++) {
    insertRun(db, { task_id: task.id, seq: i + 1, agent: 'reviewer', provider: 'fake', model: 'x' });
  }
  assert.equal(checkAttempts(db, CONFIG, task.id, 'reviewer').ok, true);
  db.close();
});

// Phase 1a real-batch fix F1: a run the provider never answered
// (failure_class 'provider_unavailable') is not an attempt by the agent.
test('checkAttempts: runs classified provider_unavailable do not count toward builder_attempts_max', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });

  for (let i = 0; i < 5; i++) {
    insertRun(db, {
      task_id: task.id, seq: i + 1, agent: 'builder', provider: 'nvidia', model: 'x',
      failure_class: 'provider_unavailable',
    });
  }
  const stillOpen = checkAttempts(db, CONFIG, task.id, 'builder');
  assert.equal(stillOpen.ok, true, 'five provider_unavailable runs must not exhaust a max of 3');
  assert.equal(stillOpen.used, 0);

  // A mix: 2 real attempts + 3 provider_unavailable ones - only the 2 count.
  insertRun(db, { task_id: task.id, seq: 6, agent: 'builder', provider: 'fake', model: 'x' });
  insertRun(db, { task_id: task.id, seq: 7, agent: 'builder', provider: 'fake', model: 'x' });
  const mixed = checkAttempts(db, CONFIG, task.id, 'builder');
  assert.equal(mixed.used, 2);
  assert.equal(mixed.ok, true);
  db.close();
});

test('computeBackoffMs: full jitter - zero for attempt with a zero-second base, and bounded by the cap', () => {
  assert.equal(computeBackoffMs(0, 1), 0);
  assert.equal(computeBackoffMs(30, 1, { random: () => 1 }), 30000); // attempt 1: 30 * 2^0 = 30s, jitter at max
  assert.equal(computeBackoffMs(30, 2, { random: () => 1 }), 60000); // attempt 2: 30 * 2^1 = 60s
  assert.equal(computeBackoffMs(30, 1, { random: () => 0 }), 0); // full jitter can be zero
  // Capped at 15 minutes (900s) regardless of how large backoffS/attempt get.
  assert.equal(computeBackoffMs(1000, 10, { random: () => 1 }), 900000);
});

test('checkChallenge: first challenge allowed, second refused', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'tri' });
  insertVerdict(db, {
    task_id: task.id, reviewer: 'reviewer', provider: 'p', model: 'm',
    decision: 'changes_requested', challenge_seq: 0,
  });
  assert.equal(checkChallenge(db, CONFIG, task.id).ok, true);

  insertVerdict(db, {
    task_id: task.id, reviewer: 'reviewer', provider: 'p', model: 'm',
    decision: 'approve', challenge_seq: 1,
  });
  const after = checkChallenge(db, CONFIG, task.id);
  assert.equal(after.ok, false);
  assert.equal(after.used, 1);
  db.close();
});

test('projectedSpend: zero with fewer than three prior runs, median once there are three or more', async () => {
  const db = await freshDb();
  const t1 = insertTask(db, { repo: 'o/n', title: 't1', task_class: 'ci', arm: 'control' });
  insertRun(db, { task_id: t1.id, seq: 1, agent: 'builder', provider: 'p', model: 'm', status: 'ok', cost_usd: 1.0 });
  insertRun(db, { task_id: t1.id, seq: 2, agent: 'builder', provider: 'p', model: 'm', status: 'ok', cost_usd: 2.0 });
  assert.equal(projectedSpend(db, CONFIG, t1.id, 'builder', 'm'), 0);

  insertRun(db, { task_id: t1.id, seq: 3, agent: 'builder', provider: 'p', model: 'm', status: 'ok', cost_usd: 3.0 });
  assert.equal(projectedSpend(db, CONFIG, t1.id, 'builder', 'm'), 2.0);
  db.close();
});

test('checkSpend: refuses a run that would push projected spend over the limit', async () => {
  const db = await freshDb();
  const t1 = insertTask(db, { repo: 'o/n', title: 't1', task_class: 'ci', arm: 'control' });
  for (const cost of [2.0, 2.0, 2.0]) {
    insertRun(db, { task_id: t1.id, seq: 1, agent: 'builder', provider: 'p', model: 'm', status: 'ok', cost_usd: cost });
  }
  const t2 = insertTask(db, { repo: 'o/n', title: 't2', task_class: 'ci', arm: 'control' });
  insertCost(db, { task_id: t2.id, provider: 'p', model: 'm', cost_usd: 4.0 });

  const check = checkSpend(db, CONFIG, t2.id, 'builder', 'm');
  assert.equal(check.actual, 4.0);
  assert.equal(check.projectedNext, 2.0);
  assert.equal(check.projected, 6.0);
  assert.equal(check.ok, false);
  db.close();
});

test('checkQuota: no provider_quota rows means unlimited', async () => {
  const db = await freshDb();
  const check = checkQuota(db, CONFIG, 'openai', 'gpt-x', 0, { isPublic: false });
  assert.equal(check.ok, true);
  db.close();
});

test('checkQuota: refuses once the request headroom is used up', async () => {
  const db = await freshDb();
  upsertQuota(db, { provider: 'google', window_kind: 'day', limit_requests: 1, used_requests: 1 });
  const check = checkQuota(db, CONFIG, 'google', null, 0, { isPublic: false });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'quota');
  db.close();
});

test('checkQuota: refuses once projected usd would exceed the limit', async () => {
  const db = await freshDb();
  upsertQuota(db, { provider: 'opencode-go', window_kind: '5h', limit_usd: 10, used_usd: 9 });
  const check = checkQuota(db, CONFIG, 'opencode-go', null, 2, { isPublic: false });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'quota');
  db.close();
});

test('checkQuota: public_only provider without isPublic refuses; with isPublic passes', async () => {
  const db = await freshDb();
  const withoutPublic = checkQuota(db, CONFIG, 'nvidia', 'nim-x', 0, { isPublic: false });
  assert.equal(withoutPublic.ok, false);
  assert.equal(withoutPublic.reason, 'public_only');

  const withPublic = checkQuota(db, CONFIG, 'nvidia', 'nim-x', 0, { isPublic: true });
  assert.equal(withPublic.ok, true);
  db.close();
});

test('transition: legal edges succeed, illegal edges throw with .code = 6', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  assert.equal(task.status, 'submitted');

  transition(db, task.id, 'working');
  assert.equal(getTask(db, task.id).status, 'working');

  transition(db, task.id, 'completed');
  assert.equal(getTask(db, task.id).status, 'completed');

  assert.throws(() => transition(db, task.id, 'working'), (e) => e.code === 6);
  db.close();
});

test('transition: unknown task throws with .code = 1', async () => {
  const db = await freshDb();
  assert.throws(() => transition(db, 't_doesnotexist', 'working'), (e) => e.code === 1);
  db.close();
});

test('escalate: halt severity moves the task to input_required, warn does not', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');

  escalate(db, { taskId: task.id, reason: 'test_edit', severity: 'warn', detail: 'x' });
  assert.equal(getTask(db, task.id).status, 'working');

  escalate(db, { taskId: task.id, reason: 'wallclock', severity: 'halt', detail: 'y' });
  assert.equal(getTask(db, task.id).status, 'input_required');

  const escalations = listEscalations(db, task.id);
  assert.equal(escalations.length, 2);
  db.close();
});

test('escalate: a halt on an already-terminal task does not reopen it', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');
  transition(db, task.id, 'completed');

  escalate(db, { taskId: task.id, reason: 'manual', severity: 'halt', detail: 'late finding' });
  assert.equal(getTask(db, task.id).status, 'completed');
  db.close();
});

test('resolveEscalations: closes open halts, logs an intervention, returns task to working', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');
  escalate(db, { taskId: task.id, reason: 'dirty_worktree', severity: 'halt', detail: 'x' });
  assert.equal(getTask(db, task.id).status, 'input_required');

  const result = resolveEscalations(db, task.id, { note: 'cleaned up', retryAuthorized: true });
  assert.equal(result.resolved, 1);
  assert.equal(getTask(db, task.id).status, 'working');

  const escalations = listEscalations(db, task.id);
  assert.ok(escalations[0].resolved_at);
  assert.equal(escalations[0].resolution, 'cleaned up');

  const authorized = db
    .prepare("SELECT COUNT(*) AS c FROM human_interventions WHERE task_id = ? AND kind = 'retry_authorized'")
    .get(task.id).c;
  assert.equal(authorized, 1);
  db.close();
});

test('retroactiveWallclock: halts a still-running run whose elapsed time exceeds its limit', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'm',
    status: 'running', started_at: '2026-01-01T00:00:00.000Z', wallclock_limit_s: 60,
  });

  const result = retroactiveWallclock(db, CONFIG, run, new Date('2026-01-01T00:05:00.000Z'));
  assert.equal(result.fired, true);

  const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(updated.status, 'halted');
  assert.equal(updated.halted_reason, 'wallclock');
  assert.equal(getTask(db, task.id).status, 'input_required');

  const escalations = listEscalations(db, task.id);
  assert.equal(escalations.some((e) => e.reason === 'wallclock'), true);
  db.close();
});

test('retroactiveWallclock: does nothing when within limit or already ended', async () => {
  const db = await freshDb();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'm',
    status: 'running', started_at: '2026-01-01T00:00:00.000Z', wallclock_limit_s: 6000,
  });
  const within = retroactiveWallclock(db, CONFIG, run, new Date('2026-01-01T00:05:00.000Z'));
  assert.equal(within.fired, false);

  const endedRun = insertRun(db, {
    task_id: task.id, seq: 2, agent: 'builder', provider: 'p', model: 'm',
    status: 'ok', started_at: '2026-01-01T00:00:00.000Z', wallclock_limit_s: 1,
  });
  const alreadyEnded = retroactiveWallclock(db, CONFIG, endedRun, new Date('2026-01-01T00:05:00.000Z'));
  assert.equal(alreadyEnded.fired, false);
  db.close();
});
