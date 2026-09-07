import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCli, makeTempDb } from './helpers.mjs';
import { openDb, migrate } from '../src/db.mjs';
import { insertTask, setTaskStatus, upsertQuota } from '../src/ledger.mjs';
import { rollQuota } from '../src/quota.mjs';

test('task:new prints a bare id with prefix t_, exit 0, no stderr', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);

  const result = runCli([
    'task:new', '--db', dbPath,
    '--repo', 'owner/name', '--title', 'Add feature', '--class', 'ci', '--arm', 'control',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const id = result.stdout.trim();
  assert.match(id, /^t_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('task:new rejects an invalid --arm with exit 1 and one stderr line', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const result = runCli([
    'task:new', '--db', dbPath,
    '--repo', 'owner/name', '--title', 'T', '--class', 'ci', '--arm', 'bogus',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.trim(), /^cortexctl: usage: --arm/);
});

test('task:show returns the task that task:new created', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);

  const created = runCli([
    'task:new', '--db', dbPath,
    '--repo', 'owner/name', '--title', 'Fix bug', '--class', 'bugfix', '--arm', 'tri',
    '--owner', 'agent-1', '--priority', '2',
  ]);
  assert.equal(created.code, 0, created.stderr);
  const id = created.stdout.trim();

  const shown = runCli(['task:show', id, '--db', dbPath, '--json']);
  assert.equal(shown.code, 0, shown.stderr);
  const view = JSON.parse(shown.stdout);
  assert.equal(view.task.id, id);
  assert.equal(view.task.title, 'Fix bug');
  assert.equal(view.task.status, 'submitted');
  assert.equal(view.task.owner, 'agent-1');
  assert.equal(view.task.priority, 2);
  assert.deepEqual(view.runs, []);
  assert.deepEqual(view.verdicts, []);
});

test('global boolean flags before the command do not swallow the next positional arg', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const created = runCli([
    'task:new', '--db', dbPath, '--repo', 'o/n', '--title', 'X', '--class', 'ci', '--arm', 'tri',
  ]);
  const id = created.stdout.trim();

  // --json placed before the command name must stay a boolean flag, not
  // consume "task:show" (or, further down the argv, the id) as its value.
  const result = runCli(['--json', 'task:show', id, '--db', dbPath]);
  assert.equal(result.code, 0, result.stderr);
  const view = JSON.parse(result.stdout);
  assert.equal(view.task.id, id);
});

test('task:show on an unknown id fails with exit 1 and one stderr line', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const result = runCli(['task:show', 't_doesnotexist', '--db', dbPath]);
  assert.equal(result.code, 1);
  const stderrLines = result.stderr.trim().split('\n');
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /^cortexctl: not_found: .*t_doesnotexist/);
});

test('board: input_required first, then priority, then due_at, terminal tasks excluded', async () => {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  await migrate(db);

  insertTask(db, { repo: 'o/n', title: 'low prio, no due', task_class: 'ci', arm: 'control', priority: 5 });
  const urgent = insertTask(db, {
    repo: 'o/n', title: 'urgent input required', task_class: 'ci', arm: 'control',
    priority: 5, due_at: '2026-12-31T00:00:00.000Z',
  });
  setTaskStatus(db, urgent.id, 'input_required');
  insertTask(db, {
    repo: 'o/n', title: 'high prio, later due', task_class: 'ci', arm: 'control',
    priority: 1, due_at: '2026-06-01T00:00:00.000Z',
  });
  insertTask(db, {
    repo: 'o/n', title: 'high prio, sooner due', task_class: 'ci', arm: 'control',
    priority: 1, due_at: '2026-01-01T00:00:00.000Z',
  });
  const done = insertTask(db, { repo: 'o/n', title: 'closed out', task_class: 'ci', arm: 'control', priority: 1 });
  setTaskStatus(db, done.id, 'completed');
  db.close();

  const result = runCli(['board', '--db', dbPath, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const titles = JSON.parse(result.stdout).map((r) => r.title);

  assert.deepEqual(titles, [
    'urgent input required',
    'high prio, sooner due',
    'high prio, later due',
    'low prio, no due',
  ]);
});

test('quota roll: 5h rolling window only resets once fully elapsed, restarting at now', async () => {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  await migrate(db);

  const start = '2026-01-01T00:00:00.000Z';
  upsertQuota(db, {
    provider: 'opencode-go', window_kind: '5h',
    window_started_at: start, limit_usd: 12, used_requests: 3, used_usd: 4,
  });

  rollQuota(db, new Date('2026-01-01T04:00:00.000Z'));
  let row = db.prepare("SELECT * FROM provider_quota WHERE provider = 'opencode-go'").get();
  assert.equal(row.window_started_at, start, 'window not yet expired, should not roll');
  assert.equal(row.used_usd, 4);

  rollQuota(db, new Date('2026-01-01T05:00:00.001Z'));
  row = db.prepare("SELECT * FROM provider_quota WHERE provider = 'opencode-go'").get();
  assert.equal(row.window_started_at, '2026-01-01T05:00:00.001Z', 'expired window restarts anchored at now');
  assert.equal(row.used_usd, 0);
  assert.equal(row.used_requests, 0);

  db.close();
});

test('quota roll: day window realigns to the calendar UTC day containing now', async () => {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  await migrate(db);

  upsertQuota(db, {
    provider: 'google', window_kind: 'day',
    window_started_at: '2026-01-01T00:00:00.000Z', limit_requests: 20, used_requests: 15,
  });

  rollQuota(db, new Date('2026-01-01T23:59:59.000Z'));
  let row = db.prepare("SELECT * FROM provider_quota WHERE provider = 'google'").get();
  assert.equal(row.window_started_at, '2026-01-01T00:00:00.000Z', 'same UTC day, should not roll yet');
  assert.equal(row.used_requests, 15);

  rollQuota(db, new Date('2026-01-05T12:00:00.000Z'));
  row = db.prepare("SELECT * FROM provider_quota WHERE provider = 'google'").get();
  assert.equal(row.window_started_at, '2026-01-05T00:00:00.000Z', 'jumps straight to the day containing now');
  assert.equal(row.used_requests, 0);

  db.close();
});
