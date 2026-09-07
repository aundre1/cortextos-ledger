import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir, runCli } from './helpers.mjs';
import { insertTask } from '../src/ledger.mjs';
import { add, list, retire, selectForPacket } from '../src/lessons.mjs';
import { buildTaskPacket } from '../src/packet.mjs';
import { adjudicate, buildReviewerBrief } from '../src/review.mjs';

async function migrated() {
  const db = openDb(makeTempDb());
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  return { db, config };
}

test('add: validates source and applies_to', async () => {
  const { db } = await migrated();
  assert.throws(() => add(db, { source: 'bogus', lesson: 'x' }), /source must be one of/);
  assert.throws(() => add(db, { source: 'human', lesson: 'x', appliesTo: 'bogus' }), /applies_to must be one of/);
  const row = add(db, { source: 'human', lesson: 'Always write a test first.' });
  assert.match(row.id, /^l_/);
  assert.equal(row.applies_to, 'all');
  assert.equal(row.status, 'active');
  assert.equal(row.confidence, 0.5);
});

test('retire: moves status to retired with a reason, list filters by status', async () => {
  const { db } = await migrated();
  const row = add(db, { source: 'human', lesson: 'x' });
  const retired = retire(db, { id: row.id, reason: 'no longer true' });
  assert.equal(retired.status, 'retired');
  assert.equal(retired.retired_reason, 'no longer true');
  assert.equal(list(db, { status: 'active' }).length, 0);
  assert.equal(list(db, { status: 'retired' }).length, 1);
});

test('selectForPacket: orders by confidence desc then recency desc, filters by task_class and actor, respects the limit', async () => {
  const { db, config } = await migrated();
  config.autonomy.lessons_per_packet = 2;

  add(db, { source: 'human', lesson: 'low confidence, all classes', appliesTo: 'all', confidence: 0.2 });
  add(db, { source: 'human', lesson: 'high confidence, builder, class ui', taskClass: 'ui', appliesTo: 'builder', confidence: 0.9 });
  add(db, { source: 'human', lesson: 'high confidence, reviewer only', appliesTo: 'reviewer', confidence: 0.9 });
  add(db, { source: 'human', lesson: 'mid confidence, class other', taskClass: 'other', appliesTo: 'all', confidence: 0.6 });
  add(db, { source: 'human', lesson: 'retired, would otherwise win', appliesTo: 'all', confidence: 1.0 });
  retire(db, { id: list(db, {}).find((l) => l.lesson.includes('retired')).id, reason: 'stale' });

  const selected = selectForPacket(db, config, { taskClass: 'ui', actor: 'builder' });
  assert.equal(selected.length, 2, 'limited to lessons_per_packet');
  assert.equal(selected[0].lesson, 'high confidence, builder, class ui');
  assert.equal(selected[1].lesson, 'low confidence, all classes');
  assert.ok(!selected.some((l) => l.applies_to === 'reviewer'), 'reviewer-only lesson excluded for a builder actor');
  assert.ok(!selected.some((l) => l.task_class === 'other'), 'mismatched task_class excluded');
});

test('packet: buildTaskPacket includes lessons[] and a markdown Lessons section', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ui', arm: 'control' });
  add(db, { source: 'human', lesson: 'Keep the diff small.', taskClass: 'ui', appliesTo: 'all', confidence: 0.7 });

  const packet = buildTaskPacket(db, config, task.id, {});
  const json = JSON.parse(packet.json);
  assert.ok(Array.isArray(json.lessons));
  assert.equal(json.lessons.length, 1);
  assert.equal(json.lessons[0].lesson, 'Keep the diff small.');
  assert.match(packet.markdown, /Lessons/);
  assert.match(packet.markdown, /Keep the diff small\./);
});

test('review:brief includes reviewer-or-all lessons after the issue text, never builder-only ones', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ui', arm: 'tri' });
  add(db, { source: 'human', lesson: 'Reviewer lesson.', taskClass: 'ui', appliesTo: 'reviewer', confidence: 0.9 });
  add(db, { source: 'human', lesson: 'Builder only lesson.', taskClass: 'ui', appliesTo: 'builder', confidence: 0.9 });

  const brief = buildReviewerBrief(db, config, { taskId: task.id, reviewer: 'reviewer', issueFile: undefined });
  assert.match(brief.markdown, /Reviewer lesson\./);
  assert.doesNotMatch(brief.markdown, /Builder only lesson\./);
  assert.ok(brief.markdown.indexOf('# Issue') < brief.markdown.indexOf('# Lessons'));
});

test('adjudicate --lesson writes a lesson with source adjudication, the task class, and confidence 0.5', async () => {
  const { db } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ui', arm: 'tri' });
  const result = adjudicate(db, { taskId: task.id, real: 1, noise: 0, lesson: 'Always guard empty arrays.' });
  assert.ok(result.lesson);
  assert.equal(result.lesson.source, 'adjudication');
  assert.equal(result.lesson.task_id, task.id);
  assert.equal(result.lesson.task_class, 'ui');
  assert.equal(result.lesson.applies_to, 'all');
  assert.equal(result.lesson.confidence, 0.5);
});

test('CLI: adjudicate --lesson --applies-to', () => {
  const dir = makeTempDir();
  const configPath = `${dir}/cortex-ledger.json`;
  writeFileSync(configPath, JSON.stringify({ db: './ledger.db', runs: './runs' }));
  const cli = (args) => runCli(['--config', configPath, ...args]);

  assert.equal(cli(['init']).code, 0);
  const taskId = cli(['task:new', '--repo', 'o/n', '--title', 'T', '--class', 'ui', '--arm', 'control']).stdout.trim();

  const result = cli(['adjudicate', '--task', taskId, '--real', '1', '--noise', '0', '--lesson', 'Guard empty input.', '--applies-to', 'builder']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^h_/);
  assert.match(result.stdout, /\nlesson: l_/);

  const list = cli(['lesson:list', '--class', 'ui', '--json']);
  const rows = JSON.parse(list.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].applies_to, 'builder');
  assert.equal(rows[0].source, 'adjudication');
});
