import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir } from './helpers.mjs';
import { insertTask, insertRun, upsertQuota, insertEscalation, setTaskStatus } from '../src/ledger.mjs';
import { doctor } from '../src/doctor.mjs';

async function migrated() {
  const db = openDb(makeTempDb());
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  return { db, config };
}

function writeRunDir({ events, out, pid, done, exit }) {
  const dir = makeTempDir();
  if (events !== undefined) writeFileSync(join(dir, 'events.jsonl'), events);
  if (out !== undefined) writeFileSync(join(dir, 'out.txt'), out);
  if (pid !== undefined) writeFileSync(join(dir, 'pid.txt'), String(pid));
  if (done) writeFileSync(join(dir, 'done.marker'), '');
  if (exit !== undefined) writeFileSync(join(dir, 'exit.txt'), String(exit));
  return dir;
}

test('doctor: reports node version and schema version / pending migrations', async () => {
  const { db, config } = await migrated();
  const result = doctor(db, config, {});
  assert.ok(result.findings.some((f) => f.text.includes('node ')));
  assert.ok(result.findings.some((f) => f.text.includes('schema version')));
});

test('doctor: always reports gh command resolution, and one line per distinct real adapter in config.agents (never fake)', async () => {
  const { db, config: base } = await migrated();
  const config = {
    ...base,
    agents: {
      builder: { adapter: 'opencode', model: 'x' },
      solo: { adapter: 'opencode', model: 'x' }, // same adapter as builder - one line, not two
      reviewer_b: { adapter: 'codex', model: 'y' },
      local_test: { adapter: 'fake' },
    },
  };
  const result = doctor(db, config, {});
  const commandLines = result.findings.filter((f) => f.text.startsWith('command '));
  const names = commandLines.map((f) => f.text.split(':')[0]);
  assert.deepEqual(new Set(names), new Set(['command opencode', 'command codex', 'command gh']));
  // Every real adapter resolves trivially on this (non-win32) test host -
  // resolveCommand's rule 1 is a pure no-op there - so every line is 'info'.
  assert.ok(commandLines.every((f) => f.level === 'info'), JSON.stringify(commandLines));
});

test('doctor: probable cause "quota" when a quota window is exhausted and the last event is a model call', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  upsertQuota(db, { provider: 'prov-quota', window_kind: 'day', limit_requests: 5, used_requests: 5 });
  const outDir = writeRunDir({
    events: '{"ts":"2026-01-01T00:00:00.000Z","type":"session.start"}\n{"ts":"2026-01-01T00:00:05.000Z","type":"message","tokens_in":10}\n',
    out: 'working...\n',
    pid: process.pid,
    done: false,
  });
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'prov-quota', model: 'x',
    status: 'running', out_dir: outDir, started_at: new Date().toISOString(),
  });

  const result = doctor(db, config, { runId: run.id });
  assert.equal(result.probableCause, 'quota');
  assert.ok(result.resolveCommand);
});

test('doctor: probable cause "killed externally or machine slept" when the process is dead with no done.marker and no exit.txt', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  const outDir = writeRunDir({
    events: '{"ts":"2026-01-01T00:00:00.000Z","type":"session.start"}\n',
    out: '',
    pid: 999999999, // not a real pid
  });
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'prov-killed', model: 'x',
    status: 'running', out_dir: outDir, started_at: new Date().toISOString(),
  });

  const result = doctor(db, config, { runId: run.id });
  assert.equal(result.probableCause, 'killed externally or machine slept');
  assert.match(result.resolveCommand, /run:end --run/);
});

test('doctor: probable cause "tool hang" when the last event is a tool call with no result', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  const outDir = writeRunDir({
    events: '{"ts":"2026-01-01T00:00:00.000Z","type":"session.start"}\n{"ts":"2026-01-01T00:00:01.000Z","type":"tool.call","tool":"bash"}\n',
    out: '',
    pid: process.pid,
  });
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'prov-hang', model: 'x',
    status: 'running', out_dir: outDir, started_at: new Date().toISOString(),
  });

  const result = doctor(db, config, { runId: run.id });
  assert.equal(result.probableCause, 'tool hang');
  assert.match(result.resolveCommand, /intervene/);
});

test('doctor: probable cause "watchdog missing" when elapsed exceeds wallclock with no escalation', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  const outDir = writeRunDir({
    events: '{"ts":"2026-01-01T00:00:00.000Z","type":"session.start"}\n',
    out: '',
    pid: process.pid,
  });
  const longAgo = new Date(Date.now() - (config.limits.wallclock_s + 1000) * 1000).toISOString();
  const run = insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'prov-watchdog', model: 'x',
    status: 'running', out_dir: outDir, started_at: longAgo,
  });

  const result = doctor(db, config, { runId: run.id });
  assert.equal(result.probableCause, 'watchdog missing');
  assert.match(result.resolveCommand, new RegExp(`run:end --run ${run.id}`));
});

test('doctor: out.txt secrets are redacted, never printed in the clear', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  const secret = 'sk-ant-' + 'a'.repeat(30);
  const outDir = writeRunDir({ events: '', out: `some log line\nkey leaked: ${secret}\n`, pid: process.pid, done: true, exit: 0 });
  const run = insertRun(db, { task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'x', out_dir: outDir, started_at: new Date().toISOString() });

  const result = doctor(db, config, { runId: run.id });
  assert.ok(!result.text.includes(secret));
  assert.ok(result.text.includes('[REDACTED]'));
});

test('doctor: task-level check reports attempts, spend, open escalations, and next_action', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  insertEscalation(db, { task_id: task.id, reason: 'files_touched', severity: 'halt', detail: '12 files' });
  setTaskStatus(db, task.id, 'input_required');

  const result = doctor(db, config, { taskId: task.id });
  assert.ok(result.findings.some((f) => f.text.includes('attempts')));
  assert.ok(result.findings.some((f) => f.text.includes('spend')));
  assert.ok(result.findings.some((f) => f.text.includes('open escalations: 1')));
  assert.ok(result.findings.some((f) => f.text.includes('next_action')));
  assert.equal(result.probableCause, 'files_touched');
  assert.match(result.resolveCommand, /task:resolve/);
});

test('doctor --all: flags a stalled running run, an input_required task, and a quota window at or above 90%', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'stalled task', task_class: 'ci', arm: 'control' });
  setTaskStatus(db, task.id, 'input_required');

  const outDir = writeRunDir({ events: `{"ts":"2020-01-01T00:00:00.000Z","type":"session.start"}\n` });
  insertRun(db, {
    task_id: task.id, seq: 1, agent: 'builder', provider: 'p', model: 'x',
    status: 'running', out_dir: outDir, started_at: '2020-01-01T00:00:00.000Z',
  });
  upsertQuota(db, { provider: 'prov-90', window_kind: 'day', limit_requests: 10, used_requests: 9 });

  const result = doctor(db, config, { all: true });
  const texts = result.findings.map((f) => f.text);
  assert.ok(texts.some((t) => t.includes('stalled')));
  assert.ok(texts.some((t) => t.includes('input_required')));
  assert.ok(texts.some((t) => t.includes('prov-90')));
});
