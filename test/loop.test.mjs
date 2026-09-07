import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir, makeTempGitRepo, runCli } from './helpers.mjs';
import { insertTask, insertLoopTick, listLoopTicks } from '../src/ledger.mjs';
import { propose, review, listProposals } from '../src/proposals.mjs';
import { tick } from '../src/loop.mjs';

async function migrated() {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  // tick() spawns real `cortexctl` child processes for an assigned task's
  // action (run:launch, run:end, ingest) - they must open the exact same db
  // file as this in-process handle, not loadConfig's unrelated default path.
  config.db = dbPath;
  config.runs = makeTempDir();
  config.autonomy = { ...config.autonomy, enabled: true };
  return { db, config };
}

function writeGoals(config, businessId) {
  writeFileSync(
    config.goals,
    JSON.stringify({
      goals_version: '1',
      businesses: [
        {
          id: businessId, name: 'Test', owner: 'founder', objective: 'grow',
          metrics: [{ name: 'paying_customers', target: 100, current: 10, source: 'manual' }],
          task_classes: ['feature'],
        },
      ],
    })
  );
}

function writeFixture(obj) {
  const path = join(makeTempDir(), 'fixture.json');
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

/** Runs `fn` with CORTEX_FAKE_FIXTURE set for the duration, restoring it after - loop.mjs's direct adapter.run() calls read it from process.env, same as fake.mjs does for run:launch. */
async function withFixture(fixturePath, fn) {
  const prev = process.env.CORTEX_FAKE_FIXTURE;
  process.env.CORTEX_FAKE_FIXTURE = fixturePath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CORTEX_FAKE_FIXTURE;
    else process.env.CORTEX_FAKE_FIXTURE = prev;
  }
}

test('tick: autonomy disabled refuses with code 6 and writes no rows', async () => {
  const { db, config } = await migrated();
  config.autonomy.enabled = false;
  await assert.rejects(() => tick(db, config, { agent: 'architect' }), (e) => e.code === 6);
  assert.equal(listLoopTicks(db, {}).length, 0);
});

test('tick: an already-assigned task executes exactly one action (run:launch) and writes one loop_ticks row', async () => {
  const { db, config } = await migrated();
  config.agents = { solo: { adapter: 'fake', provider: 'fake', model: 'fake-model' } };
  const { dir, baseCommit } = makeTempGitRepo();

  const task = insertTask(db, {
    repo: 'o/n', title: 'Do the thing', task_class: 'ci', arm: 'control',
    owner: 'builder', worktree: dir, base_commit: baseCommit, status: 'submitted',
  });

  const result = await tick(db, config, { agent: 'builder' });
  assert.equal(result.action, 'run_launch');
  assert.equal(result.taskId, task.id);
  assert.equal(listLoopTicks(db, { agent: 'builder' }).length, 1);

  const run = db.prepare('SELECT * FROM task_runs WHERE task_id = ?').get(task.id);
  assert.ok(run, 'run:launch inserted a task_runs row through the real command');
  assert.equal(run.agent, 'solo');
});

test('tick: nothing assigned drafts one proposal via the fake adapter fixture, and records its cost on _proposals', async () => {
  const { db, config } = await migrated();
  writeGoals(config, 'biz-a');
  const fixturePath = writeFixture({
    stdout_json: {
      kind: 'task', title: 'Add signup form', rationale: 'closes the paying_customers gap',
      expected_impact: 'more signups', estimated_usd: 1, estimated_hours: 2,
      task_class: 'feature', goal_metric: 'paying_customers',
    },
    costUsd: 0.05, tokensIn: 100, tokensOut: 50, requests: 1,
  });

  const result = await withFixture(fixturePath, () => tick(db, config, { agent: 'architect', business: 'biz-a' }));
  assert.equal(result.action, 'proposed');
  assert.ok(result.proposalId);
  assert.equal(result.costUsd, 0.05);

  const proposals = listProposals(db, { business: 'biz-a' });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].author, 'architect');
  assert.equal(proposals[0].title, 'Add signup form');

  const proposalsTask = db.prepare("SELECT * FROM tasks WHERE repo = 'biz-a' AND task_class = '_proposals'").get();
  assert.ok(proposalsTask, 'synthetic _proposals task exists');
  const cost = db.prepare('SELECT * FROM cost_usage WHERE task_id = ?').get(proposalsTask.id);
  assert.equal(cost.cost_usd, 0.05);
});

test('tick: an open proposal by another agent gets reviewed (support/oppose/revise) via the fake adapter fixture', async () => {
  const { db, config } = await migrated();
  config.autonomy.propose = false; // isolate the review step
  writeGoals(config, 'biz-a');
  const p = propose(db, config, {
    author: 'architect', business: 'biz-a', kind: 'task', title: 'Add signup form',
    rationale: 'r', expectedImpact: 'i', usd: 1, taskClass: 'feature',
  });

  const fixturePath = writeFixture({ stdout_json: { verdict: 'support', note: 'looks credible', confidence: 0.8 }, costUsd: 0.02 });
  const result = await withFixture(fixturePath, () => tick(db, config, { agent: 'builder', business: 'biz-a' }));

  assert.equal(result.action, 'reviewed');
  assert.equal(result.proposalId, p.id);
  const updated = db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
  assert.equal(updated.status, 'under_review');
  const reviewRow = db.prepare('SELECT * FROM proposal_reviews WHERE proposal_id = ?').get(p.id);
  assert.equal(reviewRow.reviewer, 'builder');
  assert.equal(reviewRow.verdict, 'support');
});

test('tick: the auto approve dial converts a cheap, supported proposal and stops there', async () => {
  const { db, config } = await migrated();
  config.autonomy.auto_approve_below_usd = 5;
  config.autonomy.min_reviews = 1;
  const p = propose(db, config, {
    author: 'other-agent', business: 'biz-a', kind: 'task', title: 'Cheap task',
    rationale: 'r', expectedImpact: 'i', usd: 2, taskClass: 'feature',
  });
  review(db, config, { id: p.id, reviewer: 'reviewer', verdict: 'support' });

  const result = await tick(db, config, { agent: 'architect', business: 'biz-a' });
  assert.equal(result.action, 'auto_approved');
  assert.equal(result.proposalId, p.id);
  assert.ok(result.taskId);

  const updated = db.prepare('SELECT * FROM proposals WHERE id = ?').get(p.id);
  assert.equal(updated.status, 'converted');
  assert.equal(updated.converted_task_id, result.taskId);
});

test('tick: always writes a loop_ticks row, even a noop', async () => {
  const { db, config } = await migrated();
  config.autonomy.propose = false;
  config.autonomy.review_proposals = false;
  const result = await tick(db, config, { agent: 'architect' });
  assert.equal(result.action, 'noop');
  assert.equal(listLoopTicks(db, { agent: 'architect' }).length, 1);
});

test('tick: --max-usd stops the loop from proposing/reviewing once the budget is already spent', async () => {
  const { db, config } = await migrated();
  writeGoals(config, 'biz-a');
  insertLoopTick(db, { agent: 'architect', action: 'proposed', cost_usd: 10 });

  const result = await tick(db, config, { agent: 'architect', business: 'biz-a', maxUsd: 5 });
  assert.equal(result.action, 'noop');
  assert.match(result.note, /max_usd/);
});

test('CLI: loop refuses with exit 6 when autonomy is disabled (the shipped default)', () => {
  const dir = makeTempDir();
  const configPath = `${dir}/cortex-ledger.json`;
  writeFileSync(configPath, JSON.stringify({ db: './ledger.db', runs: './runs' }));
  const cli = (args) => runCli(['--config', configPath, ...args]);
  assert.equal(cli(['init']).code, 0);
  const result = cli(['loop', '--agent', 'architect', '--once']);
  assert.equal(result.code, 6);
});
