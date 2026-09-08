import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir, runCli } from './helpers.mjs';
import { insertTask, insertTest } from '../src/ledger.mjs';
import { loadGoals, fillMetrics, setMetric } from '../src/goals.mjs';

async function migrated() {
  const db = openDb(makeTempDb());
  await migrate(db);
  const cwd = makeTempDir();
  const config = loadConfig({ cwd });
  return { db, config, cwd };
}

function writeGoals(config, businesses) {
  writeFileSync(config.goals, JSON.stringify({ goals_version: '1', businesses }, null, 2));
}

test('loadGoals: a missing file returns an empty, flagged contract rather than throwing', async () => {
  const { config } = await migrated();
  const goals = loadGoals(config);
  assert.equal(goals.missing, true);
  assert.deepEqual(goals.businesses, []);
  assert.match(goals.warning, /not found/);
});

test('fillMetrics: manual metric passes through with a gap, ledger metric resolves, unknown field is null with a note', async () => {
  const { db, config } = await migrated();
  writeGoals(config, [
    {
      id: 'biz-a', name: 'Test', owner: 'founder', objective: 'grow',
      metrics: [
        { name: 'paying_customers', target: 100, current: 42, unit: 'count', source: 'manual' },
        { name: 'first_pass_rate', target: 0.7, current: null, unit: 'ratio', source: 'ledger:report.first_pass_rate', task_class: 'feature' },
        { name: 'mystery', target: 1, current: null, source: 'ledger:report.something_unknown', task_class: 'feature' },
      ],
      constraints: [], task_classes: ['feature'],
    },
  ]);

  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'feature', arm: 'tri' });
  insertTest(db, { task_id: task.id, suite: 'unit', status: 'pass', passed: 1, failed: 0 });

  const filled = fillMetrics(db, config, loadGoals(config));
  const biz = filled.businesses[0];

  const manual = biz.metrics.find((m) => m.name === 'paying_customers');
  assert.equal(manual.current, 42);
  assert.equal(manual.gap, 58);

  const ledgerMetric = biz.metrics.find((m) => m.name === 'first_pass_rate');
  assert.equal(ledgerMetric.current, 1);
  assert.ok(Math.abs(ledgerMetric.gap - -0.3) < 1e-9);

  const unknown = biz.metrics.find((m) => m.name === 'mystery');
  assert.equal(unknown.current, null);
  assert.match(unknown.note, /unknown ledger field/);
});

test('fillMetrics: a ledger source with no matching task_class data resolves to null with a note, not a throw', async () => {
  const { db, config } = await migrated();
  writeGoals(config, [
    {
      id: 'biz-a', name: 'Test', owner: 'founder',
      metrics: [{ name: 'cost_per_task', target: 1, current: null, source: 'ledger:report.cost_per_task', task_class: 'nothing-here' }],
      task_classes: [],
    },
  ]);
  const filled = fillMetrics(db, config, loadGoals(config));
  const metric = filled.businesses[0].metrics[0];
  assert.equal(metric.current, null);
  assert.match(metric.note, /no ledger data/);
});

test('setMetric: updates a manual metric, writes the file back, and records a human_interventions note against a synthetic _goals task', async () => {
  const { db, config } = await migrated();
  writeGoals(config, [
    { id: 'biz-a', name: 'Test', owner: 'founder', metrics: [{ name: 'paying_customers', target: 100, current: 42, source: 'manual' }] },
  ]);

  const result = setMetric(db, config, { business: 'biz-a', metric: 'paying_customers', current: 55, by: 'owner1' });
  assert.equal(result.before, 42);
  assert.equal(result.after, 55);

  const raw = JSON.parse(readFileSync(config.goals, 'utf8'));
  assert.equal(raw.businesses[0].metrics[0].current, 55);

  const row = db.prepare('SELECT * FROM human_interventions WHERE id = ?').get(result.intervention.id);
  assert.equal(row.kind, 'note');
  const anchorTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id);
  assert.equal(anchorTask.task_class, '_goals');
  assert.equal(anchorTask.repo, 'biz-a');
});

test('setMetric: unknown business or metric fails clearly', async () => {
  const { db, config } = await migrated();
  writeGoals(config, [{ id: 'biz-a', name: 'Test', owner: 'founder', metrics: [{ name: 'x', target: 1, current: 0, source: 'manual' }] }]);
  assert.throws(() => setMetric(db, config, { business: 'nope', metric: 'x', current: 1 }), /no such business/);
  assert.throws(() => setMetric(db, config, { business: 'biz-a', metric: 'nope', current: 1 }), /no such metric/);
});

// ---------------------------------------------------------------------------
// CLI level
// ---------------------------------------------------------------------------

function cliConfig(dir, goalsPath) {
  const configPath = `${dir}/cortex-ledger.json`;
  writeFileSync(configPath, JSON.stringify({ db: './ledger.db', runs: './runs', goals: goalsPath }));
  return configPath;
}

test('CLI: goals:show prints the contract with gaps filled, goals:set updates it', () => {
  const dir = makeTempDir();
  const goalsPath = `${dir}/cortex-goals.json`;
  writeFileSync(
    goalsPath,
    JSON.stringify({ goals_version: '1', businesses: [{ id: 'biz-a', name: 'T', owner: 'founder', metrics: [{ name: 'x', target: 10, current: 4, source: 'manual' }] }] })
  );
  const configPath = cliConfig(dir, goalsPath);
  const init = runCli(['--config', configPath, 'init']);
  assert.equal(init.code, 0, init.stderr);

  const show = runCli(['--config', configPath, 'goals:show', '--json']);
  assert.equal(show.code, 0, show.stderr);
  const shown = JSON.parse(show.stdout);
  assert.equal(shown.businesses[0].metrics[0].gap, 6);

  const set = runCli(['--config', configPath, 'goals:set', '--business', 'biz-a', '--metric', 'x', '--current', '9']);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout.trim(), /^h_/);

  const raw = JSON.parse(readFileSync(goalsPath, 'utf8'));
  assert.equal(raw.businesses[0].metrics[0].current, 9);
});
