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

Attempts count runs whose `agent` is `builder` or `solo` on the same task, regardless of status. A run that stalled still counts. `run:start --agent builder` on a task that already has three such runs exits 3 and writes `retry_limit`. A human can authorise one more with `cortexctl task:resolve --task <id> --retry-authorized --note "..."`, which writes a `human_interventions` row of kind `retry_authorized` and raises that task's ceiling by one. There is no flag that raises it silently.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error, bad arguments, missing config |
| 2 | Preflight refused (dirty worktree, secrets found) |
| 3 | Hard limit reached |
| 4 | Provider quota exhausted or `public_only` provider asked to touch private material |
| 5 | Verdict JSON invalid |
| 6 | Task is in a state that does not allow the command (for example `run:start` on `completed`) |

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
