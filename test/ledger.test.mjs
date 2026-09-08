// Direct unit tests for src/ledger.mjs's sanitizeText and the insert
// helpers it protects (review round 2, F5): node:sqlite's TEXT bind
// silently truncates a JS string at its first embedded NUL byte
// (`db.prepare('insert into t values (?)').run('abc\0def')` reads back as
// 'abc', no error) because SQLite's C API binds through a NUL-terminated C
// string. This file both reproduces that underlying node:sqlite behaviour
// in isolation, and proves sanitizeText/the ledger inserts that call it
// route around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDb } from './helpers.mjs';
import { loadSqlite, openDb, migrate } from '../src/db.mjs';
import {
  sanitizeText,
  insertTask,
  insertMessage,
  insertArtifact,
  getTask,
} from '../src/ledger.mjs';

test('repro: node:sqlite TEXT bind truncates a JS string at an embedded NUL byte', () => {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t (x TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('abc\0def');
    const row = db.prepare('SELECT x FROM t').get();
    // This is the bug this task fixes, captured here so a future node:sqlite
    // version that no longer truncates does not silently invalidate the
    // premise of sanitizeText - if this assertion ever starts failing, the
    // underlying bug is gone and sanitizeText becomes a no-op safety net
    // rather than a required fix.
    assert.equal(row.x, 'abc', 'documents the node:sqlite TEXT-bind NUL truncation this task works around');
  } finally {
    db.close();
  }
});

test('sanitizeText strips embedded NUL bytes and passes everything else through unchanged', () => {
  assert.equal(sanitizeText('abc\0def'), 'abcdef');
  assert.equal(sanitizeText('\0\0\0'), '');
  assert.equal(sanitizeText('no nul here'), 'no nul here');
  assert.equal(sanitizeText(''), '');
  // Non-strings pass through untouched (null/undefined/numbers flow through
  // ledger.mjs's own nullish() and various numeric columns unchanged).
  assert.equal(sanitizeText(null), null);
  assert.equal(sanitizeText(undefined), undefined);
  assert.equal(sanitizeText(42), 42);
});

test('insertMessage: a body with an embedded NUL byte is stored with both sides intact ("abc\\0def" -> "abcdef")', async () => {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  try {
    await migrate(db);
    const task = insertTask(db, { repo: 'o/n', title: 'nul repro', task_class: 'ci', arm: 'control' });
    const message = insertMessage(db, {
      task_id: task.id,
      sender: 'ledger',
      recipient: 'architect',
      kind: 'brief',
      body: 'abc\0def',
    });
    assert.equal(message.body, 'abcdef', 'insertMessage should return the sanitized value it actually stored');

    const reloaded = db.prepare('SELECT body FROM agent_messages WHERE id = ?').get(message.id);
    assert.equal(reloaded.body, 'abcdef');
  } finally {
    db.close();
  }
});

test('insertTask: title and notes with embedded NUL bytes are sanitized', async () => {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  try {
    await migrate(db);
    const task = insertTask(db, {
      repo: 'o/n',
      title: 'ti\0tle',
      task_class: 'ci',
      arm: 'control',
      notes: 'no\0tes',
    });
    assert.equal(task.title, 'title');
    assert.equal(task.notes, 'notes');
    const reloaded = getTask(db, task.id);
    assert.equal(reloaded.title, 'title');
    assert.equal(reloaded.notes, 'notes');
  } finally {
    db.close();
  }
});

test('insertArtifact: sha256/bytes overrides are used verbatim when given, even for a path that does not exist on disk yet', async () => {
  const dbPath = makeTempDb();
  const db = openDb(dbPath);
  try {
    await migrate(db);
    const task = insertTask(db, { repo: 'o/n', title: 'artifact override', task_class: 'ci', arm: 'control' });
    const artifact = insertArtifact(db, {
      task_id: task.id,
      kind: 'pr_review',
      path: '/does/not/exist/pr.diff',
      sha256: 'deadbeef'.repeat(8),
      bytes: 12345,
    });
    assert.equal(artifact.sha256, 'deadbeef'.repeat(8));
    assert.equal(artifact.bytes, 12345);
    const reloaded = db.prepare('SELECT sha256, bytes FROM artifacts WHERE id = ?').get(artifact.id);
    assert.equal(reloaded.sha256, 'deadbeef'.repeat(8));
    assert.equal(reloaded.bytes, 12345);
  } finally {
    db.close();
  }
});
