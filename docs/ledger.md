# Ledger schema

Portable DDL. Rules: no `AUTOINCREMENT`, no `SERIAL`, no vendor types, text ids, ISO 8601 UTC text timestamps, `INTEGER` for booleans (0 or 1), `REAL` for money. The same files run on SQLite and Postgres.

## Migrations

`src/schema/000-base.sql` is the original eight table schema. `src/schema/001-v01.sql` applies the v0.1 changes below. A `schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` table records what has run. `cortexctl init` applies pending migrations in order and is idempotent. `cortexctl init --dry-run` prints the SQL it would apply.

Migration 001 must handle an existing database created by the original `schema.sql` (the Phase 1 pilot database). It adds columns with `ALTER TABLE ... ADD COLUMN`, creates new tables, and rewrites `tasks.status` values: `open` becomes `submitted` when the task has no runs and `working` otherwise; `halted` becomes `input_required`; `done` becomes `completed` when `outcome` is `first_pass` or `revised`, `failed` when `outcome` is `failed`, and `canceled` when `outcome` is `abandoned`.

## Tables

### tasks

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | `t_` prefix |
| created_at | TEXT | |
| repo | TEXT | `owner/name` or a local path label |
| issue_number | INTEGER | nullable |
| pr_number | INTEGER | nullable, new. Set for PR triage tasks |
| kind | TEXT | new. `implement`, `pr_review`, `research`, `ops`. Default `implement` |
| title | TEXT | |
| task_class | TEXT | free text bucket used for routing statistics, e.g. `ci-hardening`, `migration`, `ui`, `pr-triage` |
| arm | TEXT | `tri` or `control` |
| owner | TEXT | new. Human or agent id responsible for closing |
| priority | INTEGER | new. 1 highest, default 3 |
| due_at | TEXT | new, nullable |
| parent_id | TEXT | new, nullable, references tasks(id). Sub task tree |
| base_commit | TEXT | |
| branch | TEXT | |
| worktree | TEXT | new. Absolute path used for the run |
| pr_url | TEXT | |
| status | TEXT | `submitted`, `working`, `input_required`, `completed`, `canceled`, `failed`, `rejected` |
| outcome | TEXT | `first_pass`, `revised`, `failed`, `abandoned`; nullable until close |
| human_edits | INTEGER | count of human code edits before merge |
| defects_escaped | INTEGER | new. Defects found by a human after the loop declared done |
| closed_at | TEXT | |
| notes | TEXT | |

### task_runs

Adds `worktree TEXT`, `out_dir TEXT`, `exit_code INTEGER`, `files_touched INTEGER`, `wallclock_limit_s INTEGER`, `halted_reason TEXT`, `pid INTEGER`. `status` values: `running`, `ok`, `fail`, `halted`, `stalled`. `agent` values are free text but the kit ships `architect`, `builder`, `reviewer`, `reviewer_b`, `second-opinion`, `solo`.

### agent_messages

Unchanged. `kind` values: `brief`, `patch`, `verdict`, `challenge`, `rebuttal`, `escalation`, `packet`, `note`.

### artifacts

`kind` gains `packet`, `pr_review`, `usage_snapshot`, `stdout`. `sha256` and `bytes` are filled by `cortexctl artifact` when the path exists.

### review_verdicts

Adds `arm TEXT` (copied from the task at insert time so verdict statistics need no join), `challenge_seq INTEGER NOT NULL DEFAULT 0` (0 for the first blind verdict, 1 for the single allowed challenge cycle), `tests_touched INTEGER`, `scope_exceeded INTEGER`. `findings_json` must validate against `docs/review-protocol.md` before insert.

### test_results

Unchanged.

### cost_usage

Adds `requests INTEGER NOT NULL DEFAULT 0` so request based quotas can be computed from the same rows as dollar based ones.

### escalations

`reason` values: `retry_limit`, `challenge_limit`, `budget`, `wallclock`, `files_touched`, `quota`, `dirty_worktree`, `secrets`, `stall`, `tool_failure`, `test_edit`, `verdict_invalid`, `manual`. Adds `run_id TEXT` nullable and `severity TEXT` (`halt` or `warn`). A `halt` escalation moves the task to `input_required`. A `warn` escalation does not change task state.

### provider_quota (new)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | `q_` |
| provider | TEXT | `google`, `openai`, `opencode-go`, `nvidia`, `anthropic` |
| model | TEXT | nullable; null means provider wide |
| window_kind | TEXT | `minute`, `5h`, `day`, `week`, `month` |
| window_started_at | TEXT | |
| limit_requests | INTEGER | nullable |
| limit_usd | REAL | nullable |
| used_requests | INTEGER | default 0 |
| used_usd | REAL | default 0 |
| source | TEXT | `config`, `manual`, `ingest` |
| updated_at | TEXT | |

Windows roll: when `now` is past `window_started_at` plus the window length, usage resets to zero and `window_started_at` advances. `5h` windows are rolling from first use, matching OpenCode Go and Claude subscription behaviour; `day`, `week`, `month` are calendar UTC. Usage increments come from `cost_usage` rows at ingest, from `cortexctl quota:tick`, and from `run:start` itself, which reserves one request against the matching row(s) at admission (`docs/guards.md` "Reserved spend and requests") -- the run this reserved for is marked `task_runs.quota_reserved` so `ingest` does not also add a request for it from the run's real event count.

A `UNIQUE` index on `(provider, model, window_kind)` enforces at most one row per key, treating a `NULL` model (provider-wide) as one value rather than SQLite's usual "every `NULL` is distinct" rule (an expression index over `COALESCE(model, '')`, portable to Postgres unchanged). `syncConfigQuota`'s find-or-insert uses `INSERT ... ON CONFLICT DO NOTHING` against this index inside one transaction, so concurrent callers racing a never-before-seen window cannot each insert their own copy. `quota:clear --provider <p> [--model <m>] --window <kind>` deletes a row outright regardless of `source`; `syncConfigQuota` re-creates it (fresh, zero usage) only if the config still declares that window.

### human_interventions (new)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | `h_` |
| task_id | TEXT | |
| run_id | TEXT | nullable |
| created_at | TEXT | |
| kind | TEXT | `rescue`, `edit`, `adjudicate`, `approve`, `abort`, `retry_authorized`, `note` |
| minutes | INTEGER | nullable, self reported |
| detail | TEXT | |

This makes measurement field seven ("human interventions and what each one was") a structured record instead of a free text note.

### usage_snapshots (new)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | `u_` |
| created_at | TEXT | |
| provider | TEXT | |
| plan | TEXT | e.g. `claude-max-5x`, `chatgpt-plus`, `opencode-go` |
| window_kind | TEXT | |
| used_pct | REAL | 0 to 100 |
| resets_at | TEXT | nullable |
| task_id | TEXT | nullable; snapshot taken at task start or end |
| phase | TEXT | `start` or `end` |
| source | TEXT | `manual` or `scrape` |

Two snapshots bracketing a task give a subscription usage delta per task, which is the number agencies in the community said they cannot get today.

## Indexes

Keep the original eight. Add `idx_tasks_status ON tasks(status)`, `idx_tasks_owner_due ON tasks(owner, due_at)`, `idx_tasks_parent ON tasks(parent_id)`, `idx_quota_provider ON provider_quota(provider, model, window_kind)`, `idx_snap_provider ON usage_snapshots(provider, created_at)`.

## Invariants enforced in code, not in DDL

- A task has at most `builder_attempts_max` runs with `agent = 'builder'` (or `solo`).
- A task has at most one verdict with `challenge_seq = 0` per reviewer agent and at most `challenge_cycles_max` with `challenge_seq > 0`.
- Sum of `cost_usage.cost_usd` for a task never exceeds `spend_usd` without an escalation row.
- `tasks.status = 'completed'` requires `outcome` not null and at least one `test_results` row or an explicit `--no-tests` flag recorded in `notes`.
- Foreign keys are declared and `PRAGMA foreign_keys = ON` is set on every SQLite connection.

## Postgres notes for v0.2

Types map directly. Replace `PRAGMA` with nothing. Use `TIMESTAMPTZ` only if a later migration chooses to; text timestamps sort correctly in both engines. Ids stay text. `INSERT OR IGNORE` becomes `ON CONFLICT DO NOTHING`; keep these statements in a two entry dialect map in `src/db.mjs` so nothing else in the code changes.
