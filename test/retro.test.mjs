import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir } from './helpers.mjs';
import { insertTask, insertEscalation, upsertQuota } from '../src/ledger.mjs';
import { retro } from '../src/retro.mjs';

async function migrated() {
  const db = openDb(makeTempDb());
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  return { db, config };
}

function seedLedgerPatterns(db) {
  // Pattern 1: a guard fires 3+ times on the same task class.
  for (let i = 0; i < 3; i++) {
    const t = insertTask(db, { repo: 'o/n', title: `ui-${i}`, task_class: 'ui', arm: 'control' });
    insertEscalation(db, { task_id: t.id, reason: 'files_touched', severity: 'warn', detail: '12 files' });
  }
  // Pattern 6: the same tool fails 3+ times across runs.
  const toolTask = insertTask(db, { repo: 'o/n', title: 'tool-task', task_class: 'ci', arm: 'control' });
  for (let i = 0; i < 3; i++) {
    insertEscalation(db, { task_id: toolTask.id, reason: 'tool_failure', severity: 'warn', detail: 'flaky-tool: boom' });
  }
  // Pattern 7: a quota window is at its limit.
  upsertQuota(db, { provider: 'openai', window_kind: 'day', limit_requests: 5, used_requests: 5 });
}

function writeGoalsWithGap(config, businessId) {
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

test('retro: finds at least three patterns and drafts lessons/proposals for each', async () => {
  const { db, config } = await migrated();
  seedLedgerPatterns(db);
  writeGoalsWithGap(config, 'biz-a');

  const outDir = `${makeTempDir()}/retro-out`;
  const result = retro(db, config, { business: 'biz-a', outDir });

  const patterns = new Set(result.findings.map((f) => f.pattern));
  assert.ok(patterns.has('guard_firings'), 'guard_firings pattern found');
  assert.ok(patterns.has('tool_failure'), 'tool_failure pattern found');
  assert.ok(patterns.has('quota_hit'), 'quota_hit pattern found');
  assert.ok(patterns.has('goal_gap'), 'goal_gap pattern found');
  assert.ok(patterns.size >= 3, 'at least three distinct patterns triggered');

  assert.ok(result.drafted_lessons.length >= 1, 'at least one lesson drafted (guard_firings)');
  assert.ok(result.drafted_proposals.length >= 3, 'tool_failure, quota_hit, and goal_gap each draft a proposal');

  assert.ok(result.files.length === 2, 'retro.json and retro.md were written');
});

test('retro: below-threshold patterns do not draft anything', async () => {
  const { db, config } = await migrated();
  // Only 2 firings - under the threshold of 3.
  for (let i = 0; i < 2; i++) {
    const t = insertTask(db, { repo: 'o/n', title: `ui-${i}`, task_class: 'ui', arm: 'control' });
    insertEscalation(db, { task_id: t.id, reason: 'files_touched', severity: 'warn', detail: '12 files' });
  }

  const result = retro(db, config, { outDir: undefined });
  assert.equal(result.drafted_lessons.length, 0);
  assert.equal(result.findings.filter((f) => f.pattern === 'guard_firings').length, 0);
});

test('retro: a second run over the same window drafts nothing new', async () => {
  const { db, config } = await migrated();
  seedLedgerPatterns(db);
  writeGoalsWithGap(config, 'biz-a');

  const first = retro(db, config, { business: 'biz-a', outDir: `${makeTempDir()}/out1` });
  assert.ok(first.drafted_lessons.length + first.drafted_proposals.length > 0);

  const second = retro(db, config, { business: 'biz-a', outDir: `${makeTempDir()}/out2` });
  assert.deepEqual(second.drafted_lessons, []);
  assert.deepEqual(second.drafted_proposals, []);
  // The findings are still reported both times - only the drafting is deduped.
  assert.ok(second.findings.length > 0);
});
