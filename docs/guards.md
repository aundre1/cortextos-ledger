# Guards

Each guard maps to a failure that happened to someone in the community this kit was built for. The kit does not quote them; it prevents the repeat.

## Preflight (before any agent starts)

`cortexctl preflight --worktree <path> --provider <p> [--model <m>] [--public] [--allow-dirty]`

| Check | Failure prevented | Behaviour |
|---|---|---|
| Dirty worktree | An unattended agent deleted uncommitted work; one member lost a month | `git status --porcelain` must be empty of tracked changes. Untracked files are listed but allowed unless `--strict`. Refuse with exit 2 and escalation `dirty_worktree` unless `--allow-dirty` is passed, and record the flag in `notes` so the override is visible in the ledger |
| Secrets in tree | Keys placed in agent readable folders were exposed and had to be rotated | Scan tracked and untracked files under the worktree (skip `.git`, `node_modules`, binaries over 1 MB) for patterns: `-----BEGIN [A-Z ]*PRIVATE KEY`, `sk-[A-Za-z0-9]{20,}`, `sk-ant-`, `ghp_`, `github_pat_`, `AKIA[0-9A-Z]{16}`, `xox[abp]-`, `AIza[0-9A-Za-z_-]{35}`, `ya29\.`, `nvapi-`, and any file named `.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`. Report file path and line number only. Never print the matched value. Exit 2 with escalation `secrets` |
| Provider quota | A shakedown died on a 20 request per day quota after one call | Roll windows, check headroom for one request and the projected cost, then reserve it: `run:start` increments `used_requests` for the admitted run in the same atomic check, so the ceiling is enforced under concurrency, not merely read. Exit 4 with escalation `quota`. A window declared in `config.providers.<name>.windows` (`docs/architecture.md`) is enforced even if `quota:set` was never run: the config value is the ceiling until an operator overrides it, and the override then wins for good (see "Provider quota ceilings: config vs. `quota:set`" below) |
| Public only provider | Private repository content sent to a provider restricted to public material | If the provider config has `public_only: true` and `--public` is absent, exit 4 with reason `public_only` |
| Node version | `node:sqlite` missing | Exit 1 with a plain message naming 22.5 |

Preflight is invoked automatically by `run:start` unless `--no-preflight` is passed, and the skip is recorded in the run's `halted_reason` column as `preflight_skipped` so it is never silent.

### Provider quota ceilings: config vs. `quota:set`

A window under `config.providers.<name>.windows` (`docs/architecture.md`
"Configuration") is a real ceiling as soon as the config file says so --
`checkQuota`, `ingest`, `quota:tick`, and `quota:show` all seed or refresh a
matching `provider_quota` row (`source = 'config'`) from it before doing
anything else, so an operator who never runs `quota:set` still gets the
ceiling the config file documents, not silence.

`quota:set` always wins over the config for the same (provider, model,
window kind): once it has written a row (`source = 'manual'`), that row's
`limit_requests`/`limit_usd` are never touched by the config again, even if
the config file's number for that window later changes. This is the one
supported way to override a config ceiling for a single deployment without
editing the shared config file. `quota:show` prints each window's `origin`
(`config` or `quota:set`) so which one is currently in force is always
visible, not just the numbers.

Two or more concurrent processes syncing the same never-before-seen window
(`quota:show`, `preflight`, `run:start` all trigger this) cannot produce
duplicate `provider_quota` rows for it: a `UNIQUE` index on `(provider,
model, window_kind)` -- with a `NULL` model (a provider-wide window)
collapsed to one key rather than SQLite's usual "every `NULL` is distinct"
rule -- plus `INSERT ... ON CONFLICT DO NOTHING` inside one transaction make
the find-or-insert atomic. A database created before this fix may already
carry duplicates for the same key; `cortexctl init` dedupes them the first
time it applies this migration, keeping the `quota:set` (`source = 'manual'`)
row if one exists, else the oldest, and merging usage onto it by taking the
larger of each duplicate's `used_requests`/`used_usd`.

### Reserved spend and requests

A config-declared ceiling used to be read-only at `run:start`: `checkQuota`
looked at `used_requests`/`used_usd`, but nothing except `ingest` or
`quota:tick` ever wrote to them, so a burst of concurrent `run:start` calls
-- or even plain sequential ones -- could all pass the same
`limit_requests` window before the first one's usage was ever recorded. Two
changes close this:

- **Requests are reserved at admission, not just checked.** The instant
  `run:start`'s ledger gates pass (inside the same `BEGIN IMMEDIATE`
  transaction that already gates `builder_attempts_max` and
  `challenge_cycles_max`), it increments `used_requests` by one on every
  `provider_quota` row the run's provider/model matches -- the same rows the
  check itself just read, and the same model-specific-plus-provider-wide
  matching rule `quota:tick` uses. Twelve concurrent `run:start` calls
  against `limit_requests: 5` now produce exactly 5 successes, not 12. The
  run is marked `quota_reserved` so a later `ingest` of that same run does
  not also add its real event-derived request count on top of the one
  already reserved -- `ingest` still records the run's actual `cost_usd` in
  full, it just never double-counts the request `run:start` already spent.
- **usd ceilings reserve pessimistically for every run currently in
  flight.** A `running` run's real cost is unknown until it ends, so
  `checkQuota` adds a `reserved` amount to the usd check: the number of
  other runs currently `running` for the same provider, times
  `config.limits.spend_usd` (the same per-task budget cap `checkSpend`
  already enforces) -- the worst case if every one of them spent all the way
  up to its own budget. `quota:show` prints this as a `reserved_usd` column
  per window. Zero when `config.limits.spend_usd` is not set.

### Removing a window from config

Deleting a window from `config.providers.<name>.windows` does not delete or
stop enforcing the `provider_quota` row it created: `syncConfigQuota` only
ever seeds or refreshes rows for windows the config *currently* declares, it
never deletes one for a window that has disappeared from the file. The row
keeps enforcing the last limit it was synced with, forever, with real usage
still accumulating against it. This is deliberate (a config edit should
never silently lift a ceiling something depended on) but it must be
possible to actually clear a stale row once an operator means to remove it:
`quota:clear --provider <p> [--model <m>] --window <kind>` deletes that row
outright, regardless of its `source`, and prints what it deleted. If the
window is still declared in the config file, the next
`quota:show`/`preflight`/`run:start` simply re-creates it (a fresh row,
usage reset to zero).

## Runtime (while the agent runs)

The watchdog described in `state-machine.md` handles wall clock and stall. Additionally the launcher writes `pid.txt` before the harness starts and the credential boundary strips secrets from the child environment (see `security.md`).

## Post run (at run:end and ingest)

| Check | Failure prevented | Behaviour |
|---|---|---|
| Files touched | Runaway changes across forty files nobody can review | Count changed plus untracked files in the worktree relative to `base_commit`. Above `files_touched_max`, run `halted`, escalation `files_touched` severity `halt` |
| Test edit detection | Agents fixed the tests instead of the bug and later work stacked on the breakage | Any changed path matching `test_patterns` on a task whose `task_class` is not `tests` sets `review_verdicts.tests_touched` expectations and writes escalation `test_edit` severity `warn`. The reviewer brief includes the list of touched test files with the instruction to verify each edit is justified by the issue |
| Tool failure streak | An agent whose browser tool was down spent thirty minutes improvising JavaScript | Scan `events.jsonl` for consecutive tool results with `error` set. Streak of `tool_failure_streak` or more writes escalation `tool_failure` severity `warn`, with the tool name and first error message (truncated to 200 characters) |
| Scope marker | Silent incompletion, "done" without finishing | If `out.txt` or `reasoning.md` contains `SCOPE_EXCEEDED` or `BLOCKED:` the run is marked `fail` regardless of exit code and the marker line is copied into `halted_reason` |
| Missing artifacts | Builder claimed completion without a diff | For `agent = builder` or `solo` with exit 0, `patch.diff` must exist and be non empty, otherwise `run:end` marks the run `fail` with `halted_reason = no_patch` |

## Prompt level rules (shipped in `prompts/`)

These are enforced by review, not by code, and the guards above exist because prompts are ignored under pressure.

- Novice framing: the agent is told it is a careful junior engineer who must double check, not an expert. The community measured fewer false claims this way.
- A broken tool is a report, never a workaround. Stop, write `BLOCKED: <tool> <error>`, exit.
- Never edit a failing test to make it pass. If a test is wrong, say so in `reasoning.md` and leave it.
- Scope is the issue. Touching more than the file cap means stop and write `SCOPE_EXCEEDED`.
- The reviewer receives the diff and the issue only. It does not go looking for the builder's notes.

## Guard telemetry

`cortexctl report --guards` prints, per guard, how many times it fired over a period and on which tasks. This is the evidence that the guards earn their place, and it is what a maintainer needs to decide defaults.
