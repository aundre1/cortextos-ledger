// Open, migrate, dialect map, ids, now(). Zero dependencies: node:sqlite only.
//
// Every exported function here takes a `db` handle and plain values/objects,
// per the project coding rule (see .claude/tasks/todo-kit-v01-20260907.md).

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, 'schema');

// ---------------------------------------------------------------------------
// Time-sortable ids: `<prefix>_` + 26 char Crockford base32 ULID-style string
// (10 chars millisecond timestamp + 16 chars randomness).
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // excludes I, L, O, U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms, len = TIME_LEN) {
  let n = ms;
  let out = '';
  for (let i = 0; i < len; i++) {
    const mod = n % 32;
    out = CROCKFORD[mod] + out;
    n = (n - mod) / 32;
  }
  return out;
}

function encodeRandom(len = RANDOM_LEN) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    // 256 is an exact multiple of 32, so this mod is unbiased.
    out += CROCKFORD[bytes[i] % 32];
  }
  return out;
}

/** `<prefix>_` plus a 26 character time-sortable id (Crockford base32). */
export function newId(prefix) {
  return `${prefix}_${encodeTime(Date.now())}${encodeRandom()}`;
}

/** Current instant as an ISO 8601 UTC string. */
export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Dialect map: v0.1 ships SQLite only; Postgres is a v0.2 issue (docs/ledger.md
// "Postgres notes for v0.2"). Kept as a two entry map so nothing else in the
// code changes when a Postgres pool is added: `INSERT OR IGNORE` becomes a
// prefix; `ON CONFLICT DO NOTHING` becomes a suffix, and Postgres uses plain
// `INSERT` as its prefix instead.
// ---------------------------------------------------------------------------

export const dialects = {
  sqlite: {
    insertIgnore: 'INSERT OR IGNORE',
    conflictNothing: '',
  },
  postgres: {
    insertIgnore: 'INSERT',
    conflictNothing: 'ON CONFLICT DO NOTHING',
  },
};

/** Look up one SQL fragment for a dialect: sql('sqlite', 'insertIgnore'). */
export function sql(dialect, key) {
  const d = dialects[dialect];
  if (!d) throw new Error(`unknown dialect: ${dialect}`);
  if (!(key in d)) throw new Error(`unknown sql key: ${key}`);
  return d[key];
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/** Open (creating if needed) a SQLite database with the kit's pragmas. */
export function openDb(path) {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
  // Concurrent access is real, not hypothetical: `run:launch` spawns a
  // detached `cortexctl watch` process that opens its own connection to the
  // same file (docs/state-machine.md "Wall clock watchdog"), two CLI
  // invocations can legitimately race a moment apart (a test's `run:launch`
  // followed immediately by `run:end`, or two orchestrator scripts), and
  // several `run:start` processes can race outright (review round 1, F1 -
  // test/concurrency.test.mjs). Without a busy timeout, node:sqlite raises
  // SQLITE_BUSY ("database is locked") immediately instead of waiting the
  // brief moment another writer needs; this is the standard fix (not a
  // retry/sleep in the tests themselves). It is set FIRST, before any other
  // pragma or statement - `PRAGMA journal_mode = WAL` itself briefly needs
  // the write lock on a database another connection is mid-write on (most
  // often true only on the very first ever open of a fresh file, since the
  // mode then persists in the file - but that race is exactly what a dozen
  // processes calling `openDb` for the first time, concurrently, hits), so
  // setting it any later leaves that one pragma unprotected.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function ensureMigrationsTable(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
  );
}

function listSchemaFiles() {
  let names;
  try {
    names = readdirSync(SCHEMA_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.sql') || n.endsWith('.mjs'))
    .sort()
    .map((file) => ({
      file,
      version: basename(file, extname(file)),
      type: extname(file) === '.mjs' ? 'mjs' : 'sql',
      path: join(SCHEMA_DIR, file),
    }));
}

function appliedVersions(db) {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations').all();
  return new Set(rows.map((r) => r.version));
}

/** Migrations not yet recorded in schema_migrations, in filename order. */
export function pendingMigrations(db) {
  const applied = appliedVersions(db);
  return listSchemaFiles().filter((m) => !applied.has(m.version));
}

/** The most recently applied migration version, or null if none have run. */
export function schemaVersion(db) {
  ensureMigrationsTable(db);
  const row = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
    .get();
  return row ? row.version : null;
}

async function applyOne(db, migration) {
  if (migration.type === 'sql') {
    db.exec(readFileSync(migration.path, 'utf8'));
  } else {
    const mod = await import(pathToFileURL(migration.path).href);
    if (typeof mod.up !== 'function') {
      throw new Error(`migration ${migration.file} does not export up(db)`);
    }
    mod.up(db);
  }
}

// ---------------------------------------------------------------------------
// Atomic limit gates (review round 1, F1): a check-then-insert sequence
// (attempts/spend/quota gate, then insertRun; a verdict uniqueness gate,
// then insertVerdict; a proposal status gate, then insertTask) is only a
// real limit if no other connection can insert between the check and the
// write. `BEGIN IMMEDIATE` takes SQLite's RESERVED lock up front, before any
// statement runs, so a second process's own `BEGIN IMMEDIATE` blocks (up to
// `busy_timeout`, see openDb above) rather than interleaving - the two
// callers are serialized, not merely both individually consistent.
// ---------------------------------------------------------------------------

/**
 * Run `fn()` (synchronous - node:sqlite's DatabaseSync has no async surface)
 * inside a `BEGIN IMMEDIATE ... COMMIT` transaction on `db`, returning
 * whatever `fn` returns. `fn` should only read/write through `db` - no
 * external I/O (git, network, other files), since that work should already
 * be done before this is called (holding the write lock for anything slower
 * than a handful of prepared statements starves every other writer for up to
 * `busy_timeout`). On any throw from `fn`, the transaction is rolled back and
 * the error re-thrown; the caller decides what a "gate failed" result versus
 * a genuine exception looks like (a gate failure should normally be returned
 * from `fn`, not thrown, so the transaction still commits and the lock is
 * released promptly).
 */
export function withImmediateTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = fn();
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // best effort - if the connection is already unusable there is
      // nothing more productive to do than let the original error surface.
    }
    throw e;
  }
  db.exec('COMMIT');
  return result;
}

/**
 * Apply every pending migration in src/schema/, in filename order, recording
 * each in schema_migrations. Safe to call on an empty database, a database
 * already fully migrated (no-op), or a legacy database created directly from
 * the original schema.sql (000-base.sql's CREATE TABLE/INDEX IF NOT EXISTS
 * statements make re-applying it to such a database harmless).
 */
export async function migrate(db) {
  const pending = pendingMigrations(db);
  const insertVersion = `${sql('sqlite', 'insertIgnore')} INTO schema_migrations (version, applied_at) VALUES (?, ?)`;
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      await applyOne(db, migration);
      db.prepare(insertVersion).run(migration.version, nowIso());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return pending.map((m) => m.version);
}
