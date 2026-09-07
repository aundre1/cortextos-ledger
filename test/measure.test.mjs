import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir } from './helpers.mjs';
import { insertTask, insertRun, insertTest, insertCost, insertEscalation, setTaskStatus } from '../src/ledger.mjs';
import { storeVerdict, adjudicate } from '../src/review.mjs';
import { compare, report, exportTables } from '../src/measure.mjs';

async function migrated() {
  const db = openDb(makeTempDb());
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  return { db, config };
}

function validVerdict(overrides = {}) {
  return {
    decision: 'changes_requested',
    summary: 'One real bug found.',
    findings: [{ id: 'F1', severity: 'major', file: 'a.js', claim: 'bug', evidence: 'x' }],
    tests_touched: false,
    tests_touched_justified: null,
    scope_exceeded: false,
    confidence: 0.8,
    ...overrides,
  };
}

function makePair(db) {
  const control = insertTask(db, { repo: 'o/n', title: 'Issue 1', task_class: 'ci', arm: 'control', issue_number: 1 });
  const tri = insertTask(db, { repo: 'o/n', title: 'Issue 1', task_class: 'ci', arm: 'tri', issue_number: 1, sibling_id: control.id });
  return { control, tri };
}

test('compare: refuses a winner while either arm is unadjudicated', async () => {
  const { db, config } = await migrated();
  const { control, tri } = makePair(db);
  insertRun(db, { task_id: control.id, seq: 1, agent: 'solo', provider: 'p', model: 'm', status: 'ok', ended_at: new Date().toISOString() });
  insertRun(db, { task_id: tri.id, seq: 1, agent: 'builder', provider: 'p', model: 'm', status: 'ok', ended_at: new Date().toISOString() });

  const result = compare(db, config, { task: tri.id });
  assert.equal(result.ok, true);
  assert.equal(result.reading, 'unadjudicated');
  assert.equal(result.winner, null);
  db.close();
});

test('compare: control arm becomes adjudicated only once a human_interventions adjudicate row exists', async () => {
  const { db, config } = await migrated();
  const { control, tri } = makePair(db);

  storeVerdict(db, config, { taskId: tri.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false });
  adjudicate(db, { taskId: tri.id, real: 1, noise: 0, escaped: 0 });

  // tri is now adjudicated, control is not -> still unadjudicated overall.
  let result = compare(db, config, { task: tri.id });
  assert.equal(result.reading, 'unadjudicated');

  adjudicate(db, { taskId: control.id, real: 0, noise: 0, escaped: 1 });
  result = compare(db, config, { task: tri.id });
  assert.notEqual(result.reading, 'unadjudicated');
  assert.ok(result.winner);
  db.close();
});

test('compare: winner has fewer escaped defects', async () => {
  const { db, config } = await migrated();
  const { control, tri } = makePair(db);
  storeVerdict(db, config, { taskId: tri.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false });
  adjudicate(db, { taskId: tri.id, real: 1, noise: 0, escaped: 0 });
  adjudicate(db, { taskId: control.id, real: 0, noise: 0, escaped: 3 });

  const result = compare(db, config, { task: tri.id });
  assert.equal(result.winner, 'tri');
  db.close();
});

test('compare: finds the pair by --issue when both arms share repo + issue_number', async () => {
  const { db, config } = await migrated();
  const { tri } = makePair(db);
  const result = compare(db, config, { issue: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.tri.task_id, tri.id);
  db.close();
});

test('report: marks a class with fewer than 20 adjudicated runs as not routing grade', async () => {
  const { db, config } = await migrated();
  const { tri } = makePair(db);
  storeVerdict(db, config, { taskId: tri.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false });
  adjudicate(db, { taskId: tri.id, real: 1, noise: 0 });

  const result = report(db, config, {});
  const ci = result.classes.find((c) => c.task_class === 'ci');
  assert.ok(ci);
  assert.equal(ci.not_routing_grade, true);
  db.close();
});

test('report --guards and --reviewers add guard_firings and reviewer_precision', async () => {
  const { db, config } = await migrated();
  const { tri } = makePair(db);
  insertEscalation(db, { task_id: tri.id, reason: 'files_touched', severity: 'halt', detail: 'x' });
  storeVerdict(db, config, { taskId: tri.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false });
  adjudicate(db, { taskId: tri.id, real: 1, noise: 0 });

  const result = report(db, config, { guards: true, reviewers: true });
  assert.ok(result.guard_firings.some((g) => g.reason === 'files_touched' && g.count === 1));
  assert.ok(result.reviewer_precision.some((r) => r.provider === 'p' && r.precision === 1));
  db.close();
});

test('exportTables: writes one CSV per table and escapes commas, quotes, and newlines per RFC 4180', async () => {
  const { db } = await migrated();
  insertTask(db, { repo: 'o/n', title: 'Has, a comma', task_class: 'ci', arm: 'control', notes: 'line one\nline two with "quotes"' });

  const outDir = join(makeTempDir(), 'export');
  const { files } = exportTables(db, { format: 'csv', table: 'tasks', outDir });
  assert.equal(files.length, 1);
  assert.ok(existsSync(files[0]));

  const csv = readFileSync(files[0], 'utf8');
  assert.ok(csv.includes('"Has, a comma"'), 'comma-containing field is quoted');
  assert.ok(csv.includes('""quotes""'), 'internal quotes are doubled');
  assert.ok(csv.includes('line one\nline two'), 'embedded newline preserved inside quotes');

  // Round trip sanity: the quoted comma field must not have been split into two columns.
  const dataLine = csv.split('\r\n').find((l) => l.includes('Has, a comma'));
  assert.ok(dataLine.includes('"Has, a comma"'));
  db.close();
});

test('exportTables: --format json writes a JSON array per table', async () => {
  const { db } = await migrated();
  insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  const outDir = join(makeTempDir(), 'export-json');
  const { files } = exportTables(db, { format: 'json', table: 'tasks', outDir });
  const rows = JSON.parse(readFileSync(files[0], 'utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'T');
  db.close();
});

test('exportTables: with no --table, writes every known table', async () => {
  const { db } = await migrated();
  const outDir = join(makeTempDir(), 'export-all');
  const { files } = exportTables(db, { format: 'csv', outDir });
  assert.ok(files.length >= 11);
  assert.ok(files.some((f) => f.endsWith('tasks.csv')));
  assert.ok(files.some((f) => f.endsWith('usage_snapshots.csv')));
  db.close();
});
