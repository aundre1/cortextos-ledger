import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDb, makeTempDir } from './helpers.mjs';
import { openDb, migrate } from '../src/db.mjs';
import { insertTask, insertRun, listQuota, upsertQuota, listEscalations, getTask } from '../src/ledger.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { ingest } from '../src/ingest.mjs';
import { parseStream as parseClaudeStream } from '../src/adapters/claude.mjs';
import { parseStream as parseOpencodeStream } from '../src/adapters/opencode.mjs';

// ingest reads only the normalized events.jsonl format (docs/adapters.md),
// never a harness's native stream - so the raw claude-stream.jsonl fixture
// is run through the claude adapter's own parseStream first, exactly as the
// claude adapter's run() would before writing events.jsonl.
function writeNormalizedClaudeEvents(destPath, fixturePath) {
  const events = parseClaudeStream(readFileSync(fixturePath, 'utf8').split('\n'));
  writeFileSync(destPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function config(overrides = {}) {
  return { ...DEFAULTS, limits: { ...DEFAULTS.limits, ...overrides } };
}

async function freshDb() {
  const db = openDb(makeTempDb());
  await migrate(db);
  return db;
}

function makeTaskAndRun(db, { provider = 'anthropic', model = 'claude-opus-5' } = {}) {
  const task = insertTask(db, { repo: 'o/n', title: 'ingest test', task_class: 'ci', arm: 'control' });
  const outDir = join(makeTempDir(), 'run-out');
  mkdirSync(outDir, { recursive: true });
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider, model, out_dir: outDir, status: 'running',
  });
  return { task, run, outDir };
}

test('ingest: fills task_runs, cost_usage (with requests), and artifacts from a realistic events file', async () => {
  const db = await freshDb();
  const { task, run, outDir } = makeTaskAndRun(db);

  // Reuse the claude adapter fixture as the run's events.jsonl.
  const eventsPath = join(outDir, 'events.jsonl');
  writeNormalizedClaudeEvents(eventsPath, join(FIXTURES, 'claude-stream.jsonl'));

  // Only two of the four well-known artifact files are present; ingest must
  // record only those, and must skip the ones that never showed up.
  writeFileSync(join(outDir, 'patch.diff'), '--- a\n+++ b\n');
  writeFileSync(join(outDir, 'out.txt'), 'build log\n');

  const result = ingest(db, config(), { eventsPath, taskId: task.id, runId: run.id });

  assert.equal(result.tokens_in, 1550);
  assert.equal(result.tokens_out, 250);
  assert.equal(result.cost_usd, 0.0412);
  assert.equal(result.requests, 4);
  assert.equal(result.tool_calls, 3);
  assert.equal(result.session_id, 'sess_abc123');
  assert.deepEqual(result.artifacts.sort(), ['diff', 'stdout']);

  const updatedRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
  assert.equal(updatedRun.tokens_in, 1550);
  assert.equal(updatedRun.tokens_out, 250);
  assert.equal(updatedRun.cost_usd, 0.0412);
  assert.equal(updatedRun.tool_calls, 3);
  assert.equal(updatedRun.session_id, 'sess_abc123');
  assert.equal(updatedRun.status, 'ok'); // exit_code 0 from session.end, was 'running'
  assert.ok(updatedRun.summary, 'summary should be filled from the final assistant excerpt');
  assert.ok(updatedRun.summary.length <= 300);
  assert.ok(updatedRun.ended_at);

  const costRows = db.prepare("SELECT * FROM cost_usage WHERE run_id = ? AND source = 'plugin'").all(run.id);
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0].requests, 4);
  assert.equal(costRows[0].cost_usd, 0.0412);

  const artifactRows = db.prepare('SELECT kind FROM artifacts WHERE run_id = ?').all(run.id).map((r) => r.kind);
  assert.deepEqual(artifactRows.sort(), ['diff', 'stdout']);
});

test('ingest: E2-3 real opencode run --format json fixture - one cost_usage row with the exact reported totals', async () => {
  const db = await freshDb();
  const { task, run, outDir } = makeTaskAndRun(db, { provider: 'nvidia', model: 'nvidia/moonshotai/kimi-k3' });

  // Same pattern the claude case above uses: run the raw fixture through the
  // adapter's own parseStream (what run() would do before writing
  // events.jsonl) rather than hand-writing normalized events.
  const eventsPath = join(outDir, 'events.jsonl');
  const events = parseOpencodeStream(readFileSync(join(FIXTURES, 'opencode-run.real.jsonl'), 'utf8').split('\n'));
  writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const result = ingest(db, config(), { eventsPath, taskId: task.id, runId: run.id });

  assert.equal(result.tokens_in, 58646);
  assert.equal(result.tokens_out, 145);
  assert.equal(result.cost_usd, 0);
  assert.equal(result.session_id, 'ses_f80e1b494ffeeIFRT1L2arjhAx');
  assert.equal(result.tool_calls, 1);

  const costRows = db.prepare("SELECT * FROM cost_usage WHERE run_id = ? AND source = 'plugin'").all(run.id);
  assert.equal(costRows.length, 1);
  assert.equal(costRows[0].tokens_in, 58646);
  assert.equal(costRows[0].tokens_out, 145);
  assert.equal(costRows[0].cost_usd, 0);
  assert.equal(costRows[0].provider, 'nvidia');
  assert.equal(costRows[0].model, 'nvidia/moonshotai/kimi-k3');
});

test('ingest: rolls and ticks provider_quota for the run\'s provider and model', async () => {
  const db = await freshDb();
  const { task, run, outDir } = makeTaskAndRun(db, { provider: 'opencode-go', model: 'opencode/deepseek-v4' });
  upsertQuota(db, { provider: 'opencode-go', model: 'opencode/deepseek-v4', window_kind: '5h', limit_usd: 12 });

  const eventsPath = join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, readFileSync(join(FIXTURES, 'opencode-events.jsonl')));

  ingest(db, config(), { eventsPath, taskId: task.id, runId: run.id });

  const [quotaRow] = listQuota(db, { provider: 'opencode-go' });
  assert.equal(quotaRow.used_usd, 0.0031);
  assert.equal(quotaRow.used_requests, 1);
});

test('ingest: budget escalation fires once with a tiny spend_usd and halts the task', async () => {
  const db = await freshDb();
  const { task, run, outDir } = makeTaskAndRun(db);

  const eventsPath = join(outDir, 'events.jsonl');
  writeNormalizedClaudeEvents(eventsPath, join(FIXTURES, 'claude-stream.jsonl')); // cost_usd 0.0412

  const tinyConfig = config({ spend_usd: 0.001 });
  const result = ingest(db, tinyConfig, { eventsPath, taskId: task.id, runId: run.id });

  assert.ok(result.budget_escalation_id, 'a budget escalation should have been raised');
  const escalations = listEscalations(db, task.id).filter((e) => e.reason === 'budget');
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].severity, 'halt');
  assert.equal(escalations[0].run_id, run.id);

  const updatedTask = getTask(db, task.id);
  assert.equal(updatedTask.status, 'input_required');

  // A second ingest of the same over-budget run must not raise a second
  // escalation while the first is still open.
  const second = ingest(db, tinyConfig, { eventsPath, taskId: task.id, runId: run.id });
  assert.equal(second.budget_escalation_id, null);
  assert.equal(listEscalations(db, task.id).filter((e) => e.reason === 'budget').length, 1);
});

test('ingest: re-ingesting the same run does not duplicate cost_usage or artifacts, or double-tick quota', async () => {
  const db = await freshDb();
  const { task, run, outDir } = makeTaskAndRun(db, { provider: 'opencode-go', model: 'opencode/deepseek-v4' });
  upsertQuota(db, { provider: 'opencode-go', model: 'opencode/deepseek-v4', window_kind: '5h', limit_usd: 12 });

  const eventsPath = join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, readFileSync(join(FIXTURES, 'opencode-events.jsonl')));
  writeFileSync(join(outDir, 'out.txt'), 'log\n');

  ingest(db, config(), { eventsPath, taskId: task.id, runId: run.id });
  ingest(db, config(), { eventsPath, taskId: task.id, runId: run.id });
  ingest(db, config(), { eventsPath, taskId: task.id, runId: run.id });

  const costRows = db.prepare("SELECT * FROM cost_usage WHERE run_id = ? AND source = 'plugin'").all(run.id);
  assert.equal(costRows.length, 1, 'still exactly one plugin cost row after three ingests');

  const artifactRows = db.prepare('SELECT * FROM artifacts WHERE run_id = ?').all(run.id);
  assert.equal(artifactRows.length, 1, 'still exactly one artifact row after three ingests');

  const [quotaRow] = listQuota(db, { provider: 'opencode-go' });
  assert.equal(quotaRow.used_usd, 0.0031, 'quota usage reflects the run once, not three times');
  assert.equal(quotaRow.used_requests, 1);
});
