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
  // Each line is either a real resolution (level info, "<name>: <resolvedFrom>
  // (<path>)") or NOT FOUND (level warn, "<name>: NOT FOUND (<cmd>)") - which
  // one depends on whether that harness is actually installed on *this* host,
  // so (unlike the old, host-dependent assertion here) this never hardcodes
  // 'info': a CI runner missing opencode/codex (e.g. windows-latest with
  // neither installed) legitimately reports NOT FOUND/warn for them, and
  // that is correct doctor behavior, not a bug. See the NOT FOUND-shape test
  // below for the platform-injected case that pins down the warn shape
  // itself, deterministically, independent of what's installed on any host.
  for (const f of commandLines) {
    const isNotFound = / NOT FOUND \(/.test(f.text);
    assert.equal(f.level, isNotFound ? 'warn' : 'info', JSON.stringify(f));
    // The resolved path may contain spaces (C:\Program Files\...), so the
    // parenthesised tail is "anything non-empty", not \S+.
    if (!isNotFound) assert.match(f.text, /^command \S+: \S.* \(.+\)$/, JSON.stringify(f));
  }
});

test('doctor: NOT FOUND shape - command resolution warns with "NOT FOUND (<cmd>)" when injected win32 + empty PATH cannot resolve any harness', async () => {
  const { db, config: base } = await migrated();
  const config = {
    ...base,
    agents: {
      builder: { adapter: 'opencode', model: 'x' },
      reviewer_b: { adapter: 'codex', model: 'y' },
    },
  };
  // Deterministic, host-independent: resolveCommand is a no-op passthrough
  // on every non-win32 platform (docs/adapters.md rule 1), so NOT FOUND can
  // only be produced by actually injecting platform: 'win32' together with
  // a PATH empty of every harness - never by relying on what happens to be
  // installed on whatever host runs this suite.
  const result = doctor(db, config, { platform: 'win32', env: { PATH: '' } });
  const commandLines = result.findings.filter((f) => f.text.startsWith('command '));
  assert.equal(commandLines.length, 3); // opencode, codex, gh
  for (const f of commandLines) {
    assert.equal(f.level, 'warn', JSON.stringify(f));
    assert.match(f.text, /^command \S+: NOT FOUND \(\S+\)$/, JSON.stringify(f));
  }
});

// D1: "cortexctl doctor shows whether auth.json was found" (this task's own
// requirement, examples/config.opencode-go.json's new _note).
test('doctor: reports opencode auth.json found, with provider count, when config.agents uses adapter opencode', async () => {
  const { db, config: base } = await migrated();
  const config = { ...base, agents: { builder: { adapter: 'opencode', model: 'x' } } };
  const authPath = join('/data', 'opencode', 'auth.json');
  const result = doctor(db, config, {
    authEnv: { XDG_DATA_HOME: '/data' },
    authHomedir: '/home/op',
    authExistsSync: (p) => p === authPath,
    authReadFile: () => JSON.stringify({ 'opencode-go': {}, google: {} }),
  });
  const line = result.findings.find((f) => f.text.startsWith('opencode auth.json:'));
  assert.ok(line, JSON.stringify(result.findings));
  assert.equal(line.level, 'info');
  assert.match(line.text, /found at .*auth\.json \(2 providers\)/);
});

test('doctor: reports opencode auth.json not found (warn) when it does not exist', async () => {
  const { db, config: base } = await migrated();
  const config = { ...base, agents: { builder: { adapter: 'opencode', model: 'x' } } };
  const result = doctor(db, config, {
    authEnv: {},
    authHomedir: '/home/op',
    authExistsSync: () => false,
  });
  const line = result.findings.find((f) => f.text.startsWith('opencode auth.json:'));
  assert.ok(line, JSON.stringify(result.findings));
  assert.equal(line.level, 'warn');
  assert.match(line.text, /not found/);
});

test('doctor: no opencode auth.json line at all when no configured agent uses adapter opencode', async () => {
  const { db, config: base } = await migrated();
  const config = { ...base, agents: { builder: { adapter: 'codex', model: 'x' } } };
  const result = doctor(db, config, {});
  assert.equal(result.findings.some((f) => f.text.startsWith('opencode auth.json:')), false);
});

// D2: doctor surfaces an agent.fallback event found in a run's events.jsonl
// as a warn-level finding (opencode.mjs's createStreamParser emits these -
// see test/adapters.test.mjs "createStreamParser: ... becomes an
// agent.fallback event").
test('doctor: surfaces agent.fallback events found in a run\'s events.jsonl as a warn finding', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  const outDir = writeRunDir({
    events:
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', type: 'agent.fallback', severity: 'warn', agent: 'blind-reviewer', reason: 'not_found' }) +
      '\n' +
      JSON.stringify({ ts: '2026-01-01T00:00:01Z', type: 'session.end', exit_code: 0 }) +
      '\n',
    done: true,
    exit: 0,
  });
  const run = insertRun(db, { task_id: task.id, seq: 1, agent: 'blind-reviewer', provider: 'google', model: 'x', out_dir: outDir });
  const result = doctor(db, config, { runId: run.id });
  const line = result.findings.find((f) => f.text.startsWith('agent.fallback events:'));
  assert.ok(line, JSON.stringify(result.findings));
  assert.equal(line.level, 'warn');
  assert.match(line.text, /blind-reviewer/);
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
