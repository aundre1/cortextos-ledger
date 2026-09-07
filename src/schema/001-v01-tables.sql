-- v0.1 additions, part 1: brand new tables and the indexes that depend only on
-- columns already present (either in 000-base.sql or created by this file).
--
-- Column additions to existing tables (tasks, task_runs, review_verdicts,
-- cost_usage, escalations) live in 002-v01-columns.mjs instead of here,
-- because SQLite's ALTER TABLE ADD COLUMN fails if the column already exists
-- and this file must stay safe to re-run (CREATE TABLE/INDEX IF NOT EXISTS
-- only). Two indexes (idx_tasks_owner_due, idx_tasks_parent) reference
-- columns that do not exist until 002 runs, so they are created there too,
-- after the columns are added, to keep migration files strictly in order.

CREATE TABLE IF NOT EXISTS provider_quota (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  model             TEXT,                     -- nullable; null means provider wide
  window_kind       TEXT NOT NULL,            -- minute | 5h | day | week | month
  window_started_at TEXT NOT NULL,
  limit_requests    INTEGER,
  limit_usd         REAL,
  used_requests     INTEGER NOT NULL DEFAULT 0,
  used_usd          REAL NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'config',  -- config | manual | ingest
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_interventions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT,
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- rescue | edit | adjudicate | approve | abort | retry_authorized | note
  minutes       INTEGER,                -- nullable, self reported
  detail        TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  plan          TEXT,
  window_kind   TEXT,
  used_pct      REAL,                   -- 0 to 100
  resets_at     TEXT,
  task_id       TEXT,                   -- nullable; snapshot taken at task start or end
  phase         TEXT,                   -- start | end
  source        TEXT NOT NULL DEFAULT 'manual'   -- manual | scrape
);

CREATE INDEX IF NOT EXISTS idx_quota_provider ON provider_quota(provider, model, window_kind);
CREATE INDEX IF NOT EXISTS idx_snap_provider  ON usage_snapshots(provider, created_at);

-- tasks.status already exists in 000-base.sql, so this index is safe here.
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
