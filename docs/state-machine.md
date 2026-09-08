# State machine and hard limits

Everything the original Phase 1 spec asked the operator to enforce by hand is enforced here by `cortexctl`, and breaches always leave an `escalations` row. A limit that can be forgotten is not a limit.

## Task states

```
submitted ──run:start──► working ──task:close──► completed | failed
    │                       │
    │                       ├── halt escalation ──► input_required ──resolve──► working
    │                       │                                       └──abort──► canceled
    └──task:close --outcome abandoned──► canceled

rejected: set by task:reject when the architect refuses the brief (never entered from working)
```

`input_required` is the only state a human must act on. `cortexctl board` lists these first.

## Run states

`running` on `run:start`. `ok` or `fail` on `run:end` by exit code (0 is `ok`, anything else `fail`). `halted` when a guard killed it (wall clock, files touched at end, budget). `stalled` when the watchdog observed no event for `stall_s` and killed it.

## The five hard limits

| Limit | Config key | Default | Enforced where | Breach |
|---|---|---|---|---|
| Builder attempts | `builder_attempts_max` | 3 | `run:start` | Exit 3, escalation `retry_limit`, task `input_required` |
| Challenge cycles | `challenge_cycles_max` | 1 | `verdict` | Exit 3, escalation `challenge_limit`, verdict not stored |
| Wall clock per run | `wallclock_s` | 5400 | watchdog during the run, and `run:start` for the task total | Process tree killed, run `halted`, escalation `wallclock`, task `input_required` |
| Spend per task | `spend_usd` | 5.00 | `run:start` (projected) and `ingest` (actual) | Exit 3 at start; at ingest, escalation `budget` and task `input_required` |
| Files touched per run | `files_touched_max` | 10 | `run:end` computes `git diff --name-only <base>` plus untracked in the worktree | Run `halted`, escalation `files_touched` severity `halt`, task `input_required`. The diff is kept for a human; it is not discarded |

Two soft limits with `warn` escalations: `stall_s` (default 900, no event written for fifteen minutes) and `tool_failure_streak` (default 3 consecutive tool errors in `events.jsonl`). A stall kills the process, a tool failure streak does not, because the builder prompt already instructs a stop and report; the escalation exists so the ledger shows how often the prompt rule was ignored.

## Attempt counting

Attempts count runs whose `agent` is `builder` or `solo` on the same task, regardless of status, **except** a run classified `task_runs.failure_class = 'provider_unavailable'` (below) - a provider refusing to answer is not an attempt by the agent, so it is excluded from both the count and the ceiling check (`checkAttempts`, `src/limits.mjs`; the same exclusion is used everywhere else an attempt count is shown, including `cortexctl packet`/`doctor`). A run that stalled, or genuinely failed for any other reason, still counts. `run:start --agent builder` on a task that already has three such (countable) runs exits 3 and writes `retry_limit`. A human can authorise one more with `cortexctl task:resolve --task <id> --retry-authorized --note "..."`, which writes a `human_interventions` row of kind `retry_authorized` and raises that task's ceiling by one. There is no flag that raises it silently.

The *challenge cycle* count (the "Blind review gate" below) is derived entirely from `review_verdicts.challenge_seq`, never from `task_runs` - a builder run's `failure_class` has no bearing on it either way; there is nothing to exclude there.

## Provider unavailable

Real evidence from a production batch: 12 of 16 runs failed with `out.txt` containing exactly one line - a normalized `error` event (`docs/adapters.md`) reporting a provider's own `429 Too Many Requests`, with `retryable: true`. An ordinary `fail` status would have counted every one of those against `builder_attempts_max` for a failure the agent never had a chance to attempt.

`run:end` (`src/commands/runs.mjs`) classifies a run's `task_runs.failure_class` as `provider_unavailable` when its `events.jsonl` stream ended on a terminal `error` event with `retryable: true` and no successful completion (no `session.end` anywhere in the file with `exit_code: 0`) - see `src/guards/postrun.mjs`'s `classifyFailureClass`. This classification never itself writes an escalation and never changes task status; it is read back by `checkAttempts` (above) and reported by `doctor` (below).

`run:launch --retry <n> --retry-backoff-s <seconds>` (defaults `0`/`30`) is the operator-facing use of this classification: passing `--retry` makes `run:launch` wait for its own run to finish (instead of firing and forgetting), and on a `provider_unavailable` outcome it waits `backoff × 2^(attempt-1)` with full jitter, capped at 15 minutes, then relaunches - reusing the same task, each retry a new run - up to `n` extra attempts. Each wait is logged to stderr. Exactly one `warn` escalation (reason `provider_unavailable`) is written when the retry budget is exhausted, never one per retry, with the attempt count in its detail. Omitting `--retry` entirely keeps `run:launch`'s original fire-and-forget behaviour unchanged - no waiting, no retrying, no escalation from this path (a run classified this way and never retried simply carries the `failure_class` on its row until something calls `run:end`).

`cortexctl doctor` reports, per provider ever seen in `task_runs`, how many runs in the last 24 hours ended `provider_unavailable`, `warn`-level when nonzero, so an operator can see a lane is throttled without reading a transcript.

Per-attempt directory archiving: every attempt of the same `(task, agent)` writes into the same out dir, `<runs>/<task>/<agent>/` (`docs/architecture.md`'s runtime layout is per task+agent, not per run), so before a retried attempt's harness spawns, `run:launch` moves -- never deletes, the owner's standing "archive, never delete" rule -- whatever the previous attempt left there into `<outDir>/attempts/<previous run id>/`, recording that path on the previous run's own `task_runs.attempt_evidence_dir` (`docs/ledger.md`). This closes a confirmed real defect: without it, a stale `done.marker` from the attempt that just finished satisfies the retry loop's wait for the *new* attempt's completion immediately, and `run:end` classifies the new run entirely from the old attempt's leftover `exit.txt`/`events.jsonl`, so a genuinely still-failing retry can be misreported as done.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error, bad arguments, missing config |
| 2 | Preflight refused (dirty worktree, secrets found) |
| 3 | Hard limit reached |
| 4 | Provider quota exhausted or `public_only` provider asked to touch private material |
| 5 | Verdict JSON invalid |
| 6 | Task is in a state that does not allow the command (for example `run:start` on `completed`; `task:archive` on a task with a run still `running`, reason `task_state`; `purge` on a task that is not already archived, reason `not_archived`; any command that would add to or advance an archived task, reason `archived` -- see "Archive, never delete" below) |
| 7 | `run:launch --retry` exhausted its retry budget: every attempt ended `provider_unavailable` (terminal retryable provider error, no successful completion) |

Every non zero exit prints one line to stderr in the form `cortexctl: <reason>: <detail>` and, where applicable, the escalation id. Scripts key on the code, humans read the line.

## Wall clock watchdog

`cortexctl watch --run <id>` is started by the launcher immediately after the harness process, detached, and polls every ten seconds. It reads `pid.txt`, `events.jsonl` mtime, `done.marker`. On `done.marker` it exits 0. On elapsed greater than `wallclock_s` it kills the process tree (`taskkill /PID <pid> /T /F` on Windows, `process.kill(-pgid, 'SIGKILL')` elsewhere, where the launcher created a new process group), writes `exit.txt` as `137`, writes the escalation, and exits 0. On no event for `stall_s` it does the same with `stalled`. The watchdog is its own process so a wedged harness cannot take it down; if the watchdog itself dies, `run:end` compares `started_at` to now and applies the wall clock rule retroactively.

## Spend projection at run:start

Projected spend is the task's actual spend so far plus the median cost of completed runs for the same agent and model across the ledger, or zero when fewer than three such runs exist. If projected spend exceeds `spend_usd`, `run:start` exits 3 with reason `budget` and detail showing both numbers. This is a projection, not a bill; it exists so a fourth expensive run does not start when three have already spent 4.80 USD.

## Quota gate at run:start

For the run's provider and model, every window row in `provider_quota` is rolled forward, then checked: `used_requests + 1 > limit_requests` or `used_usd + projected_cost > limit_usd` refuses with exit 4 and escalation `quota`. Providers with `public_only: true` additionally require `--public` on `run:start`, which the architect passes only when the repository is public or the material is sanitized; absent the flag, exit 4 with reason `public_only`.

## Blind review gate

`verdict --task <id>` with `challenge_seq 0` is accepted once per reviewer agent. A second `challenge_seq 0` verdict from the same reviewer is refused with exit 6. `challenge_seq 1` is accepted only if a `challenge_seq 0` verdict exists and `challenge_cycles_max` is not yet reached, and it requires a preceding `agent_messages` row of kind `challenge` from the architect, so the ledger shows that the builder's reasoning was released before the second verdict and not before the first.

## Close gate

`task:close` requires: an outcome; for `implement` tasks, at least one `test_results` row or `--no-tests`; no open `halt` escalations. It sets `closed_at`, copies `arm` into any verdict rows that lack it, and prints the compare hint if the sibling arm task exists.

## Archive, never delete

Owner's explicit instruction: work is set aside for later retrieval, never deleted. `task:archive --task <id> [--reason ...]` sets `tasks.archived_at`/`archive_reason` (never a status transition of its own -- an archived task keeps whatever `status` it already had) and writes a `human_interventions` row of kind `archive` (`docs/ledger.md`). It is refused with **exit 6, reason `task_state`** while any of the task's runs is still `running` -- archiving resolves nothing and kills nothing, so a run that could still finish and write its own result is left alone. `task:unarchive --task <id>` clears both columns.

An archived task is excluded from `board`, `compare`, and every `report` statistic (first-pass rate, mean cost, mean elapsed, reviewer precision, guard firings), the same exclusion `report` already applies to an unadjudicated task (`docs/measurement.md` "Archived tasks") -- `task:show` and `export` are unaffected, so nothing is ever lost from the record.

**Archived means nothing new attaches, independent of escalations.** Real Phase 1a defect: a driver looked up "is there already a task for PR 1002, arm control" by reading `export --table tasks`, found an ARCHIVED task, and launched into it. `run:launch` refused with exit 6 reason `task_state` ("task has N open halt escalation(s); resolve first") -- the right outcome for the wrong reason: it refused *because that archived task happened to carry halt escalations*, not because it was archived. An archived task with none would have accepted the run, silently reviving work the operator had set aside.

Fixed: `checkNotArchived` (`src/limits.mjs`) is called first, before any other state or gate check, by every command that would add to or advance a task -- `run:start` (and so `run:launch`, which calls it), `review:brief`, `verdict`, `msg`, `artifact`, `test`, `intervene`, `task:close`, `adjudicate`, `task:resolve`, `task:reject`, and `task:new`'s `--sibling`/`--parent` linkage (a *new* task may not name an archived one as either -- the attachment runs both directions). Each refuses with **exit 6, reason `archived`** (the row above), naming `archived_at`/`archive_reason` in the detail, so a driver can tell "this was deliberately set aside" from "this is blocked by open escalations" -- exactly the distinction the Phase 1a defect blurred. `task:unarchive` is always the way back: every one of these commands works again immediately once `archived_at` is cleared, since `checkNotArchived` reads it fresh on every call. `task:show`, `export`, `board`, `preflight`, and `watch` are unaffected -- they read or diagnose, they never attach anything new. `run:end`, `watch`, and `ingest` are not given this check: a run can only reach any of them while its `task_runs.status` is `running`, and `task:archive` itself already refuses while any run on the task is still `running` (the row above this section), so none of the three can ever fire against a task that is archived without first going through a race outside this fix's scope.

The deeper cause, not just the one refusal: the driver had to know to filter on `archived_at` itself when reading `export`. `cortexctl task:find` (`docs/cli.md`) is the supported lookup path so nothing has to.

`purge --task <id> --confirm` still exists (test cleanup only) and still deletes rows outright, with no undo. It now refuses with **exit 6, reason `not_archived`** unless the task is already archived -- nothing can be deleted through `purge` without having first gone through `task:archive`, so an operator cannot lose work to `purge` by reflex the way its absence used to allow. `purge`'s own `--confirm` usage message and `docs/cli.md` row both say plainly that it deletes irreversibly and that `task:archive` is the intended way to set work aside instead.
