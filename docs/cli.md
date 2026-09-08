# CLI reference: `cortexctl`

Global flags: `--config <path>`, `--db <path>` (overrides config), `--json` (machine readable output on stdout, one object), `--quiet`. All ids are printed bare on stdout when a command creates one, so `$t = (cortexctl task:new ...).Trim()` keeps working.

## Setup

| Command | Effect |
|---|---|
| `init [--dry-run]` | Create the database, apply pending migrations, print schema version |
| `doctor [--task <id> \| --run <id> \| --all]` | Diagnose (see below) |
| `config:show` | Print resolved config with paths made absolute |
| `quota:set --provider <p> [--model <m>] --window <kind> [--limit-requests <n>] [--limit-usd <x>]` | Upsert a quota window, overriding the config for that (provider, model, window) permanently -- see `docs/guards.md` "Provider quota ceilings: config vs. quota:set" |
| `quota:tick --provider <p> [--model <m>] [--requests <n>] [--usd <x>]` | Manual usage increment |
| `quota:show` | All windows (including any declared only in `config.providers.<name>.windows` and never set by hand) with headroom, `reserved_usd` (in-flight spend from currently `running` runs, see `docs/guards.md` "Reserved spend and requests"), reset time, and `origin` (`config` or `quota:set`) |
| `quota:clear --provider <p> [--model <m>] --window <kind>` | Delete that provider_quota window row (any source), print what was deleted -- see `docs/guards.md` "Removing a window from config" |

## Tasks

| Command | Effect |
|---|---|
| `task:new --repo <r> --title <t> --class <c> --arm tri\|control [--issue <n> \| --pr <n>] [--kind implement\|pr_review\|research\|ops] [--base <sha>] [--branch <b>] [--worktree <path>] [--owner <id>] [--priority <n>] [--due <iso>] [--parent <task>] [--sibling <task>]` | Insert task, status `submitted`, print id |
| `task:show <id>` | Task, runs, verdicts, tests, escalations |
| `task:close --task <id> --outcome first_pass\|revised\|failed\|abandoned [--pr <url>] [--human-edits <n>] [--no-tests] [--note ...]` | Close gate, see state machine |
| `task:resolve --task <id> [--retry-authorized] --note ...` | Resolve open `halt` escalations, task back to `working`, records intervention |
| `task:reject --task <id> --note ...` | Architect refuses the brief |
| `board [--owner <id>] [--status <s>]` | Table of open tasks, `input_required` first |

`task:new --kind pr_review --repo owner/name --pr <n>` additionally captures the pull request via `gh` (argv, `shell: false`) before the task row is inserted: `gh pr view <n> --repo owner/name --json number,title,body,baseRefOid,headRefOid,baseRefName,headRefName`, then `gh pr diff <n> --repo owner/name`. On success it stores `pr_number`, `pr_repo`, `base_sha`, `head_sha` on the task (and defaults `base_commit`/`branch` from the PR when `--base`/`--branch` were not given), writes the redacted diff to `<runs>/<task-id>/pr.diff` (an `artifacts` row of kind `pr_review` points at it), and writes the redacted PR title and body into an `agent_messages` row of kind `brief` from `ledger`. A diff over 2,000,000 bytes is still written in full, with a note added to the task and a warning on stderr - never truncated. `gh` missing, not authenticated, the PR not found, or any other non-zero `gh` exit all fail the command before any row is inserted (exit 1, one stderr line `cortexctl: gh_missing: ...` or `cortexctl: gh_failed: ...`) - see docs/state-machine.md's exit code table and this feature's own OPEN QUESTION in the wave log for why code 1 rather than a new code. `--kind pr_review` without `--pr`, or `--pr` with a different `--kind`, is unaffected: it only sets `pr_number`, exactly as before this capture existed.

## Runs

| Command | Effect |
|---|---|
| `preflight --worktree <p> --provider <p> [--model <m>] [--adapter <x>] [--public] [--allow-dirty] [--strict]` | Guards, exit 1/2/4 on refusal. `--adapter` additionally checks Windows command resolution for that adapter -- omit it and this check is skipped, same as `run:start` -- see `docs/guards.md` "Command resolution" and `docs/adapters.md` "Windows command resolution" |
| `run:start --task <id> --agent <a> [--adapter <x>] [--provider <p>] [--model <m>] [--public] [--no-preflight]` | Limit and quota gates, insert run, print run id. Never spawns anything, so it never checks command resolution -- it still admits a run on a host where the resolved adapter's harness is not installed at all |
| `run:launch --task <id> --agent <a> --prompt-file <f> [--detach] [--retry <n>] [--retry-backoff-s <seconds>]` | `run:start` plus adapter spawn plus watchdog; the one command an orchestrator needs. Unlike `run:start`, it always passes its resolved adapter to preflight's command resolution check (`docs/guards.md` "Command resolution") since it is about to spawn that adapter's harness -- exit 1 with reason `command_not_found` if that harness cannot be found anywhere on PATH |
| `run:end --run <id> [--exit <code>] [--tokens-in <n>] [--tokens-out <n>] [--cost <x>] [--summary ...]` | Post run guards, files touched, status |
| `watch --run <id>` | Watchdog process, started by `run:launch` |

`--retry <n>` (default `0`) and `--retry-backoff-s <seconds>` (default `30`) opt `run:launch` into waiting for its own run to finish and relaunching it when the run ends `provider_unavailable` (`docs/state-machine.md` "Provider unavailable") -- omitting `--retry` entirely keeps the original fire-and-forget behaviour (returns immediately after spawn, no waiting, no retrying). With `--retry` given, each `provider_unavailable` outcome sleeps `backoff × 2^(attempt-1)` with full jitter, capped at 15 minutes, logs the wait to stderr, and relaunches the same task as a new run, up to `n` extra attempts. Exit 0 on any attempt that is not `provider_unavailable`. Exit 7 (`docs/state-machine.md`'s exit code table) with exactly one `warn` escalation, reason `provider_unavailable`, if every attempt (the first plus all `n` retries) ends `provider_unavailable` -- the escalation's detail names the attempt count; nothing is written per retry.
| `ingest --events <file> --task <id> --run <id>` | Replay normalized events into the ledger and quota |
| `msg --task <id> --kind <k> --from <a> --to <b> --body <file\|text>` | Insert agent message |
| `artifact --task <id> [--run <id>] --kind <k> --path <p>` | Insert artifact with sha256 and bytes |

## Review

| Command | Effect |
|---|---|
| `review:brief --task <id> --reviewer <agent> [--issue-file <f>]` | Write the blind reviewer brief |
| `verdict --task <id> --run <id> --reviewer <agent> --provider <p> --model <m> --file <verdict.json> [--challenge]` | Validate and store, exit 5 on a semantic validation failure (nothing stored), exit 3 on challenge limit. An over-600-character `summary` is truncated at a word boundary and stored, not rejected -- `review_verdicts.summary_truncated_from` records the original length and a `warn` escalation (`verdict_truncated`) is written; see `docs/review-protocol.md`'s validation paragraph |
| `adjudicate --task <id> --real <n> --noise <n> [--escaped <n>] [--minutes <m>] [--note ...]` | Human adjudication |
| `triage:note --task <id>` | Markdown triage comment for a PR |

## Tests and closing

| Command | Effect |
|---|---|
| `test --task <id> [--run <id>] --suite <name> --status pass\|fail\|error\|skipped [--passed <n>] [--failed <n>] [--duration-ms <n>] [--log <path>] [--command ...]` | Record a suite |
| `intervene --task <id> [--run <id>] --kind rescue\|edit\|approve\|abort\|note [--minutes <m>] --detail ...` | Record a human intervention |

## Packet, measurement, usage

| Command | Effect |
|---|---|
| `packet --task <id> \| --board [--owner <id>] [--format json\|md\|both] [--max-bytes <n>] [--out <dir>]` | Context packet |
| `compare --issue <n> \| --pr <n> \| --task <id>` | Tri versus control |
| `report [--class <c>] [--since <iso>] [--guards] [--reviewers]` | Statistics |
| `export --format csv\|json [--table <t>] [--since <iso>] --out <dir>` | Dump |
| `usage:snapshot --provider <p> --plan <name> --window <kind> --used-pct <x> [--resets-at <iso>] [--task <id>] [--phase start\|end]` | Manual subscription usage snapshot |
| `usage:delta --task <id>` | Usage percent consumed by a task per provider, from bracketing snapshots |
| `limits` | Print effective limits |
| `purge --task <id> --confirm` | Delete a task and its rows (test cleanup only) |

## Doctor

`doctor` answers "why did my agent go dark" without reading a transcript. Checks in order and prints one diagnosis line per finding plus a probable cause:

1. Node version and `node:sqlite` availability.
2. Database present, schema version, pending migrations.
3. Command resolution (`docs/adapters.md` "Windows command resolution"): one line per distinct real adapter (`claude`/`codex`/`opencode`, never `fake`) named by any agent in `config.agents`, plus one for `gh` always -- each names the resolved command's path and how it got there (`exe on PATH`, `npm shim -> exe`, `npm shim -> node + js`, `cmd.exe fallback`, `NOT FOUND`), `warn`-level when nothing on PATH matched at all.
4. For a run: `pid.txt` present and process alive; `done.marker` present; `exit.txt` value; `events.jsonl` last event type and age; `out.txt` last non empty line with secrets redacted; watchdog escalation rows; quota windows for the run's provider and whether any is exhausted; elapsed against `wallclock_s`.
5. For a task: attempts used, spend used, open escalations, the derived `next_action`.
6. For `--all`: every `running` run older than `stall_s` with no recent event, every `input_required` task, every quota window at or above 90 percent.
7. Provider health: for every provider ever seen in `task_runs`, how many of its runs ended `task_runs.failure_class = 'provider_unavailable'` in the last 24 hours (`docs/state-machine.md` "Provider unavailable") -- `warn`-level when the count is nonzero, `info`-level (and printed) when zero, so a throttled lane is visible without reading a transcript.

Probable cause is chosen by rule: quota exhausted and last event is a model call → `quota`; process dead, no `done.marker`, no `exit.txt` → `killed externally or machine slept`; last event is a tool call with no result → `tool hang`; elapsed past the wall clock with no escalation → `watchdog missing`. Output ends with the exact `cortexctl` command that resolves the state when one exists.

## Autonomy (docs/autonomy.md, default off)

Every command below is a no-op or refuses outright unless `config.autonomy.enabled`
is `true` (default `false`); `loop` refuses with exit 6 while it is off. None of
these merge anything on their own - `proposal:approve` and `policy:apply` are
the only two that change what runs, and both require a human `--by`.

| Command | Effect |
|---|---|
| `goals:show [--business <id>] [--json]` | Print the goals contract with ledger sourced metrics filled and a gap per metric |
| `goals:set --business <id> --metric <name> --current <n> [--by <who>]` | Update a manual metric's current value, recording who did it |
| `propose --author <a> --business <id> --kind task\|policy\|tooling\|experiment --title <t> --rationale <text\|file> --impact <text> [--metric <name>] [--usd <n>] [--hours <n>] [--class <c>]` | Author a proposal |
| `proposal:review --id <p> --reviewer <a> --verdict support\|oppose\|revise [--note ...] [--confidence <0-1>]` | Review a proposal (never your own; exit 6 on self-review) |
| `proposal:list [--status <s>] [--business <id>] [--json]` | List proposals |
| `proposal:approve --id <p> --by <who> [--note ...] [--force]` | Human approval: converts an eligible proposal to a task |
| `proposal:reject --id <p> --by <who> --note ...` | Human refusal of a proposal |
| `lesson:add --source adjudication\|retro\|human --lesson <text> [--task <id>] [--class <c>] [--applies-to builder\|reviewer\|architect\|all] [--evidence <text>] [--confidence <0-1>]` | Add a lesson, injected into packets/briefs for its task class and actor |
| `lesson:list [--class <c>] [--applies-to <a>] [--status <s>] [--json]` | List active/retired lessons |
| `lesson:retire --id <l> --reason ...` | Retire a lesson so it stops being injected |
| `adjudicate --task <id> --real <n> --noise <n> [--escaped <n>] [--minutes <m>] [--note ...] [--lesson <text>] [--applies-to <a>]` | Human adjudication; `--lesson` drafts a lesson in the same call |
| `retro [--since <iso>] [--business <id>] [--out <dir>] [--json]` | Read the ledger for every docs/autonomy.md pattern, draft lessons/proposals without duplicating an open one, write `retro.md`/`retro.json` |
| `policy:apply --id <po> --by <who> [--overrides <json\|file>]` | Apply a policy proposal as `config.agents` overrides for its task class; refuses under 20 supporting runs (exit 6) |
| `policy:revert --id <po>` | Deactivate a routing policy |
| `policy:list [--class <c>] [--active <true\|false>] [--json]` | List routing policies |
| `loop --agent <a> [--once] [--max-tasks <n>] [--max-usd <n>] [--business <id>] [--adapter <x>] [--json]` | One bounded autonomous action per tick: an assigned task's next action, an auto approve, a drafted proposal, or a proposal review; always records a `loop_ticks` row |
