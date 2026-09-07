-- CortexOS ledger. Portable DDL: runs on SQLite (Phase 1) and Postgres (Phase 2).
-- No AUTOINCREMENT, no SERIAL, no vendor types. Ids are application generated TEXT.
-- Timestamps are ISO 8601 UTC strings.

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  repo          TEXT NOT NULL,
  issue_number  INTEGER,
  title         TEXT NOT NULL,
  task_class    TEXT NOT NULL,          -- e.g. ci-hardening, migration, ui, billing
  arm           TEXT NOT NULL,          -- tri | control
  base_commit   TEXT,
  branch        TEXT,
  pr_url        TEXT,
  status        TEXT NOT NULL,          -- open | done | halted
  outcome       TEXT,                   -- first_pass | revised | failed | abandoned
  human_edits   INTEGER NOT NULL DEFAULT 0,
  closed_at     TEXT,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,       -- 1-based attempt number within the task
  agent         TEXT NOT NULL,          -- architect | builder | reviewer | second-opinion
  provider      TEXT NOT NULL,          -- anthropic | openai | google | nvidia
  model         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  status        TEXT,                   -- ok | fail | halted
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT,
  summary       TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT,
  created_at    TEXT NOT NULL,
  sender        TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- brief | patch | verdict | challenge | rebuttal | escalation
  body          TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT,
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- diff | reasoning | test_log | review | plan
  path          TEXT,
  sha256        TEXT,
  bytes         INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS review_verdicts (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT,
  created_at    TEXT NOT NULL,
  reviewer      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  blind         INTEGER NOT NULL DEFAULT 1,   -- 1 = reviewer had no builder reasoning
  decision      TEXT NOT NULL,          -- approve | changes_requested | reject
  findings_total    INTEGER NOT NULL DEFAULT 0,
  findings_real     INTEGER,            -- adjudicated later by the human
  findings_noise    INTEGER,
  findings_json TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS test_results (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT,
  created_at    TEXT NOT NULL,
  suite         TEXT NOT NULL,
  command       TEXT,
  status        TEXT NOT NULL,          -- pass | fail | error | skipped
  passed        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  log_path      TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS cost_usage (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  run_id        TEXT,
  created_at    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  source        TEXT,                   -- plugin | manual | provider_api
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS escalations (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  reason        TEXT NOT NULL,          -- retry_limit | challenge_limit | budget | wallclock | files_touched | manual
  detail        TEXT,
  resolved_at   TEXT,
  resolution    TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_runs_task     ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_msgs_task     ON agent_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_art_task      ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_verdict_task  ON review_verdicts(task_id);
CREATE INDEX IF NOT EXISTS idx_tests_task    ON test_results(task_id);
CREATE INDEX IF NOT EXISTS idx_cost_task     ON cost_usage(task_id);
CREATE INDEX IF NOT EXISTS idx_esc_task      ON escalations(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_class   ON tasks(task_class, arm);
