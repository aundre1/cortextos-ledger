import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir, runCli } from './helpers.mjs';
import { insertTask } from '../src/ledger.mjs';
import { adjudicate } from '../src/review.mjs';
import { propose } from '../src/proposals.mjs';
import { apply, revert, activeFor, listPolicy } from '../src/policy.mjs';

async function migrated() {
  const db = openDb(makeTempDb());
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  return { db, config };
}

function adjudicatedControlTasks(db, taskClass, n) {
  for (let i = 0; i < n; i++) {
    const t = insertTask(db, { repo: 'o/n', title: `T${i}`, task_class: taskClass, arm: 'control' });
    adjudicate(db, { taskId: t.id, real: 0, noise: 0, escaped: 0 });
  }
}

test('apply: refused when the recomputed supporting run count is under 20', async () => {
  const { db, config } = await migrated();
  adjudicatedControlTasks(db, 'ci', 5);
  const p = propose(db, config, { author: 'architect', business: 'biz-a', kind: 'policy', title: 'Swap reviewer', rationale: 'low precision', expectedImpact: 'raise precision', taskClass: 'ci' });

  assert.throws(
    () => apply(db, config, { proposalId: p.id, by: 'owner1', overrides: { reviewer: { provider: 'openai', model: 'x' } } }),
    (e) => e.code === 6 && /needs at least 20/.test(e.message)
  );
  assert.equal(activeFor(db, 'ci'), null);
});

test('apply: succeeds at >= 20 adjudicated runs, activeFor returns the overrides, revert deactivates', async () => {
  const { db, config } = await migrated();
  adjudicatedControlTasks(db, 'ci', 20);
  const p = propose(db, config, { author: 'architect', business: 'biz-a', kind: 'policy', title: 'Swap reviewer', rationale: 'low precision', expectedImpact: 'raise precision', taskClass: 'ci' });

  const { policy } = apply(db, config, { proposalId: p.id, by: 'owner1', overrides: { reviewer: { provider: 'openai', model: 'gpt' } } });
  assert.match(policy.id, /^po_/);
  assert.equal(policy.active, 1);

  const active = activeFor(db, 'ci');
  assert.ok(active);
  assert.deepEqual(active.overrides, { reviewer: { provider: 'openai', model: 'gpt' } });
  assert.equal(activeFor(db, 'other-class'), null);

  revert(db, { id: policy.id });
  assert.equal(activeFor(db, 'ci'), null);
  assert.equal(listPolicy(db, { taskClass: 'ci' })[0].active, 0);
});

test('apply: refuses a non-policy-kind proposal', async () => {
  const { db, config } = await migrated();
  adjudicatedControlTasks(db, 'ci', 20);
  const p = propose(db, config, { author: 'architect', business: 'biz-a', kind: 'task', title: 'x', rationale: 'y', expectedImpact: 'z', taskClass: 'ci' });
  assert.throws(() => apply(db, config, { proposalId: p.id, by: 'owner1', overrides: {} }), /requires kind policy/);
});

test('run:start consults the active policy for the task class before config.agents', async () => {
  const dir = makeTempDir();
  const configPath = `${dir}/cortex-ledger.json`;
  writeFileSync(configPath, JSON.stringify({
    db: './ledger.db', runs: './runs',
    agents: { reviewer: { adapter: 'fake', provider: 'anthropic', model: 'from-config' } },
  }));
  const cli = (args) => runCli(['--config', configPath, ...args]);
  assert.equal(cli(['init']).code, 0);

  for (let i = 0; i < 20; i++) {
    const t = cli(['task:new', '--repo', 'o/n', '--title', `T${i}`, '--class', 'ci', '--arm', 'control']).stdout.trim();
    assert.equal(cli(['adjudicate', '--task', t, '--real', '0', '--noise', '0']).code, 0);
  }
  const proposalId = cli(['propose', '--author', 'architect', '--business', 'biz-a', '--kind', 'policy', '--title', 'Swap reviewer', '--rationale', 'r', '--impact', 'i', '--class', 'ci']).stdout.trim();
  const overridesPath = `${dir}/overrides.json`;
  writeFileSync(overridesPath, JSON.stringify({ reviewer: { adapter: 'fake', provider: 'openai', model: 'from-policy' } }));
  const applyResult = cli(['policy:apply', '--id', proposalId, '--by', 'owner1', '--overrides', overridesPath]);
  assert.equal(applyResult.code, 0, applyResult.stderr);

  const taskId = cli(['task:new', '--repo', 'o/n', '--title', 'Real task', '--class', 'ci', '--arm', 'tri']).stdout.trim();
  const runId = cli(['run:start', '--task', taskId, '--agent', 'reviewer', '--no-preflight']).stdout.trim();
  const run = JSON.parse(cli(['task:show', taskId, '--json']).stdout).runs.find((r) => r.id === runId);
  assert.equal(run.provider, 'openai');
  assert.equal(run.model, 'from-policy');
});
