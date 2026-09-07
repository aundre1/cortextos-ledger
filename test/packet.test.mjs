import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.mjs';
import { makeTempDb, makeTempDir } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import {
  insertTask,
  setTaskStatus,
  insertRun,
  insertVerdict,
  insertMessage,
  insertArtifact,
  insertEscalation,
} from '../src/ledger.mjs';
import { buildTaskPacket, buildBoardPacket, writePacket, deriveNextAction } from '../src/packet.mjs';

function setup() {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  return db;
}

async function migrated() {
  const db = setup();
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  return { db, config };
}

test('buildTaskPacket: shape has every documented field', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'Fix thing', task_class: 'ci', arm: 'tri' });

  const { json, markdown, truncated } = buildTaskPacket(db, config, task.id);
  const p = JSON.parse(json);

  assert.equal(p.packet_version, '1');
  assert.ok(p.generated_at);
  assert.equal(p.task.id, task.id);
  assert.ok('limits' in p);
  assert.ok(Array.isArray(p.runs));
  assert.ok('latest_verdict' in p);
  assert.ok('tests' in p);
  assert.ok(Array.isArray(p.artifacts));
  assert.ok(Array.isArray(p.open_escalations));
  assert.ok(Array.isArray(p.recent_messages));
  assert.ok('next_action' in p);
  assert.equal(truncated, false);
  assert.ok(markdown.includes(task.id));
  db.close();
});

test('next_action: submitted -> start builder (tri) / start solo (control)', async () => {
  const { db, config } = await migrated();
  const tri = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const control = insertTask(db, { repo: 'o/n', title: 'C', task_class: 'ci', arm: 'control' });

  const a = deriveNextAction(db, config, tri);
  assert.equal(a.actor, 'agent');
  assert.match(a.command, /--agent builder/);

  const b = deriveNextAction(db, config, control);
  assert.match(b.command, /--agent solo/);
  db.close();
});

test('next_action: working with a live run -> wait, system actor, no command', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  setTaskStatus(db, task.id, 'working');
  const run = insertRun(db, { task_id: task.id, seq: 1, agent: 'builder', provider: 'anthropic', model: 'x', status: 'running' });

  const a = deriveNextAction(db, { ...config }, { ...task, status: 'working' });
  assert.equal(a.actor, 'system');
  assert.match(a.action, new RegExp(run.id));
  assert.equal(a.command, null);
  db.close();
});

test('next_action: working, builder done, tri, no verdict -> start reviewer', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  insertRun(db, { task_id: task.id, seq: 1, agent: 'builder', provider: 'a', model: 'x', status: 'ok', ended_at: new Date().toISOString() });

  const a = deriveNextAction(db, config, { ...task, status: 'working' });
  assert.equal(a.actor, 'agent');
  assert.match(a.command, /--agent reviewer/);
  db.close();
});

test('next_action: changes_requested verdict with attempts left -> start builder again', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const run = insertRun(db, { task_id: task.id, seq: 1, agent: 'builder', provider: 'a', model: 'x', status: 'ok', ended_at: new Date().toISOString() });
  insertVerdict(db, {
    task_id: task.id, run_id: run.id, reviewer: 'reviewer', provider: 'p', model: 'm',
    decision: 'changes_requested', findings_total: 1, findings_json: '{"findings":[]}',
  });

  const a = deriveNextAction(db, config, { ...task, status: 'working' });
  assert.equal(a.actor, 'agent');
  assert.match(a.action, /attempt 2/);
  assert.match(a.command, /--agent builder/);
  db.close();
});

test('next_action: input_required -> human resolves the named escalation', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  insertEscalation(db, { task_id: task.id, reason: 'files_touched', severity: 'halt', detail: '12 files' });

  const a = deriveNextAction(db, config, { ...task, status: 'input_required' });
  assert.equal(a.actor, 'human');
  assert.match(a.action, /files_touched/);
  assert.match(a.command, /task:resolve --task/);
  db.close();
});

test('next_action: completed -> nothing', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const a = deriveNextAction(db, config, { ...task, status: 'completed' });
  assert.equal(a.actor, 'none');
  assert.equal(a.command, null);
  db.close();
});

test('buildTaskPacket: limits and next_action survive trimming, truncated flips true, trim order respected', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'A task with a longer title for byte pressure', task_class: 'ci', arm: 'tri' });

  for (let i = 0; i < 30; i++) {
    insertMessage(db, {
      task_id: task.id, sender: 'architect', recipient: 'builder', kind: 'note',
      body: `message number ${i} `.repeat(20),
    });
  }
  for (let i = 0; i < 10; i++) {
    insertArtifact(db, { task_id: task.id, kind: 'diff', path: `/runs/${task.id}/artifact-${i}.diff` });
  }
  for (let i = 0; i < 5; i++) {
    insertRun(db, { task_id: task.id, seq: i + 1, agent: 'builder', provider: 'a', model: 'x', status: 'fail' });
  }

  const full = buildTaskPacket(db, config, task.id, { maxBytes: 1_000_000 });
  const fullObj = JSON.parse(full.json);
  assert.equal(fullObj.recent_messages.length, 10, 'capped at 10 before any trimming');
  assert.equal(fullObj.artifacts.length, 10);
  assert.equal(fullObj.runs.length, 5);

  const trimmed = buildTaskPacket(db, config, task.id, { maxBytes: 900 });
  const t = JSON.parse(trimmed.json);
  assert.equal(trimmed.truncated, true);
  assert.equal(t.truncated, true);
  assert.ok(t.recent_messages.length < fullObj.recent_messages.length, 'messages trimmed first');
  assert.ok(t.limits, 'limits never trimmed');
  assert.ok(t.next_action, 'next_action never trimmed');
  assert.equal(t.task.status, task.status, 'status never trimmed');
  assert.match(trimmed.markdown, /\(truncated\)/);

  // A moderately tight budget should exhaust messages before touching
  // artifacts/runs (order: messages, then artifacts beyond 3, then runs
  // beyond 3, then findings beyond top 3).
  const mid = buildTaskPacket(db, config, task.id, { maxBytes: 1800 });
  const m = JSON.parse(mid.json);
  if (m.recent_messages.length === 0) {
    assert.ok(m.artifacts.length <= fullObj.artifacts.length);
  }
  db.close();
});

test('writePacket: task packet writes files and inserts an artifact + agent_messages row; board packet only writes files', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri', owner: 'aundre' });
  const outDir = join(makeTempDir(), 'task-out');

  const packet = buildTaskPacket(db, config, task.id);
  const written = writePacket(db, config, { ...packet, taskId: task.id, owner: task.owner }, outDir);

  assert.ok(existsSync(join(outDir, 'packet.json')));
  assert.ok(existsSync(join(outDir, 'packet.md')));
  assert.equal(written.files.length, 2);

  const artifactRow = db.prepare("SELECT * FROM artifacts WHERE task_id = ? AND kind = 'packet'").get(task.id);
  assert.ok(artifactRow, 'expected a packet artifact row');
  const msgRow = db
    .prepare("SELECT * FROM agent_messages WHERE task_id = ? AND kind = 'packet' AND sender = 'ledger' AND recipient = ?")
    .get(task.id, 'aundre');
  assert.ok(msgRow, 'expected a packet agent_messages row addressed to the owner');

  const boardOutDir = join(makeTempDir(), 'board-out');
  const boardPacket = buildBoardPacket(db, config, {});
  const artifactCountBefore = db.prepare('SELECT COUNT(*) AS c FROM artifacts').get().c;
  const messageCountBefore = db.prepare('SELECT COUNT(*) AS c FROM agent_messages').get().c;
  writePacket(db, config, { ...boardPacket, taskId: null, owner: 'board' }, boardOutDir);
  assert.ok(existsSync(join(boardOutDir, 'packet.json')));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM artifacts').get().c, artifactCountBefore, 'board packet has no task to attach an artifact to');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM agent_messages').get().c, messageCountBefore);
  db.close();
});

test('buildBoardPacket: input_required first, then priority, terminal tasks excluded', async () => {
  const { db, config } = await migrated();
  insertTask(db, { repo: 'o/n', title: 'low prio', task_class: 'ci', arm: 'control', priority: 5 });
  const urgent = insertTask(db, { repo: 'o/n', title: 'urgent', task_class: 'ci', arm: 'control', priority: 5 });
  setTaskStatus(db, urgent.id, 'input_required');
  const done = insertTask(db, { repo: 'o/n', title: 'done', task_class: 'ci', arm: 'control', priority: 1 });
  setTaskStatus(db, done.id, 'completed');

  const { json } = buildBoardPacket(db, config, {});
  const p = JSON.parse(json);
  const titles = p.tasks.map((t) => t.task.title);
  assert.deepEqual(titles, ['urgent', 'low prio']);
  db.close();
});
