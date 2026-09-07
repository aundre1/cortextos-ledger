-- v0.2 autonomy layer (docs/autonomy.md): proposals, proposal reviews,
-- lessons, routing policy, and loop ticks. Same portability rules as every
-- other migration file: no AUTOINCREMENT, no SERIAL, text ids, ISO 8601 UTC
-- text timestamps, INTEGER for booleans, REAL for money.

CREATE TABLE IF NOT EXISTS proposals (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL,
  author              TEXT NOT NULL,          -- agent or human id
  business_id         TEXT NOT NULL,
  goal_metric         TEXT,                    -- nullable
  kind                TEXT NOT NULL,           -- task | policy | tooling | experiment
  title               TEXT NOT NULL,
  rationale           TEXT,
  expected_impact     TEXT,                    -- free text tied to a metric
  estimated_usd       REAL,
  estimated_hours     REAL,
  task_class          TEXT,
  status              TEXT NOT NULL DEFAULT 'proposed', -- proposed | under_review | approved | rejected | converted | expired
  converted_task_id   TEXT REFERENCES tasks(id),
  decided_by          TEXT,
  decided_at          TEXT,
  decision_note       TEXT
);

CREATE TABLE IF NOT EXISTS proposal_reviews (
  id            TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL REFERENCES proposals(id),
  created_at    TEXT NOT NULL,
  reviewer      TEXT NOT NULL,          -- agent id
  verdict       TEXT NOT NULL,          -- support | oppose | revise
  note          TEXT,
  confidence    REAL
);

CREATE TABLE IF NOT EXISTS lessons (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  source          TEXT NOT NULL,        -- adjudication | escalation | retro | agent | human
  task_id         TEXT REFERENCES tasks(id),  -- nullable
  business_id     TEXT,                 -- nullable
  task_class      TEXT,                 -- nullable, null means all
  applies_to      TEXT NOT NULL,        -- builder | reviewer | architect | all
  lesson          TEXT NOT NULL,        -- one or two sentences, imperative
  evidence        TEXT,                 -- ids and counts, no prose
  confidence      REAL NOT NULL DEFAULT 0.5,
  status          TEXT NOT NULL DEFAULT 'active', -- active | retired
  retired_reason  TEXT
);

CREATE TABLE IF NOT EXISTS policy (
  id                    TEXT PRIMARY KEY,
  applied_at            TEXT NOT NULL,
  proposal_id           TEXT REFERENCES proposals(id),  -- nullable
  task_class            TEXT NOT NULL,
  agent_overrides_json  TEXT NOT NULL,
  applied_by            TEXT NOT NULL,
  active                INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS loop_ticks (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  action        TEXT NOT NULL,
  task_id       TEXT,
  proposal_id   TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status_business  ON proposals(status, business_id);
CREATE INDEX IF NOT EXISTS idx_proposal_reviews_proposal   ON proposal_reviews(proposal_id);
CREATE INDEX IF NOT EXISTS idx_lessons_class_applies_status ON lessons(task_class, applies_to, status);
CREATE INDEX IF NOT EXISTS idx_policy_class_active         ON policy(task_class, active);
CREATE INDEX IF NOT EXISTS idx_loop_ticks_agent_started    ON loop_ticks(agent, started_at);
