import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.mjs';
import { makeTempDb, makeTempDir } from './helpers.mjs';
import { insertTask, insertRun, listEscalations, getTask } from '../src/ledger.mjs';
import { transition } from '../src/limits.mjs';
import { tick } from '../src/guards/watchdog.mjs';

const CONFIG = {
  limits: {
    builder_attempts_max: 3, challenge_cycles_max: 1, wallclock_s: 100,
    spend_usd: 5.0, files_touched_max: 10, stall_s: 60,
  },
};

async function freshDb() {
  const db = openDb(makeTempDb());
  await migrate(db);
  return db;
}

function makeRunningTask(db) {
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');
  return task;
}

test('tick: done.marker present -> "done", no side effects', async () => {
  const db = await freshDb();
  const task = makeRunningTask(db);
  const outDir = makeTempDir();
  writeFileSync(join(outDir, 'done.marker'), '');
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'm',
    status: 'running', out_dir: outDir, started_at: '2026-01-01T00:00:00.000Z',
    wallclock_limit_s: 100, pid: 999999,
  });

  const result = tick(db, CONFIG, run, new Date('2026-01-01T00:00:10.000Z'));
  assert.equal(result, 'done');
  assert.equal(db.prepare('SELECT status FROM task_runs WHERE id = ?').get(run.id).status, 'running');
});

test('tick: within wall clock and stall limits -> "running"', async () => {
  const db = await freshDb();
  const task = makeRunningTask(db);
  const outDir = makeTempDir();
  const eventsPath = join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, '{"type":"session.start"}\n');

  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'm',
    status: 'running', out_dir: outDir, started_at: '2026-01-01T00:00:00.000Z',
    wallclock_limit_s: 100, pid: 999999,
  });

  const result = tick(db, CONFIG, run, new Date('2026-01-01T00:00:10.000Z'));
  assert.equal(result, 'running');
});

test('tick: elapsed past wallclock_limit_s -> "wallclock": run halted, exit.txt 137, halt escalation', async () => {
  const db = await freshDb();
  const task = makeRunningTask(db);
  const outDir = makeTempDir();
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'm',
    status: 'running', out_dir: outDir, started_at: '2026-01-01T00:00:00.000Z',
    wallclock_limit_s: 100, pid: 999999999,
  });

  const result = tick(db, CONFIG, run, new Date('2026-01-01T00:05:00.000Z'));
  assert.equal(result, 'wallclock');

  const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(updated.status, 'halted');
  assert.equal(updated.halted_reason, 'wallclock');

  const exitPath = join(outDir, 'exit.txt');
  const { readFileSync, existsSync } = await import('node:fs');
  assert.ok(existsSync(exitPath));
  assert.equal(readFileSync(exitPath, 'utf8'), '137');

  const escalations = listEscalations(db, task.id);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, 'wallclock');
  assert.equal(escalations[0].severity, 'halt');
  assert.equal(getTask(db, task.id).status, 'input_required');
});

test('tick: does not overwrite an exit.txt the adapter already wrote', async () => {
  const db = await freshDb();
  const task = makeRunningTask(db);
  const outDir = makeTempDir();
  writeFileSync(join(outDir, 'exit.txt'), '42');
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'm',
    status: 'running', out_dir: outDir, started_at: '2026-01-01T00:00:00.000Z',
    wallclock_limit_s: 100, pid: 999999999,
  });

  tick(db, CONFIG, run, new Date('2026-01-01T00:05:00.000Z'));
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(outDir, 'exit.txt'), 'utf8'), '42');
});

test('tick: no event for stall_s -> "stall": run stalled, warn escalation, task stays working', async () => {
  const db = await freshDb();
  const task = makeRunningTask(db);
  const outDir = makeTempDir();
  const eventsPath = join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, '{"type":"session.start"}\n');
  // Back-date the file's mtime so it looks stale without needing to sleep.
  const staleTime = new Date('2026-01-01T00:00:00.000Z');
  utimesSync(eventsPath, staleTime, staleTime);

  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'm',
    status: 'running', out_dir: outDir, started_at: '2026-01-01T00:00:00.000Z',
    wallclock_limit_s: 100000, pid: 999999999,
  });

  const result = tick(db, CONFIG, run, new Date('2026-01-01T00:05:00.000Z'));
  assert.equal(result, 'stall');

  const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(updated.status, 'stalled');
  assert.equal(updated.halted_reason, 'stall');

  const escalations = listEscalations(db, task.id);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, 'stall');
  assert.equal(escalations[0].severity, 'warn');
  // A warn escalation does not move the task to input_required.
  assert.equal(getTask(db, task.id).status, 'working');
});
