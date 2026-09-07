# CLI reference: `cortexctl`

Global flags: `--config <path>`, `--db <path>` (overrides config), `--json` (machine readable output on stdout, one object), `--quiet`. All ids are printed bare on stdout when a command creates one, so `$t = (cortexctl task:new ...).Trim()` keeps working.

## Setup

| Command | Effect |
|---|---|
| `init [--dry-run]` | Create the database, apply pending migrations, print schema version |
| `doctor [--task <id> \| --run <id> \| --all]` | Diagnose (see below) |
| `config:show` | Print resolved config with paths made absolute |
| `quota:set --provider <p> [--model <m>] --window <kind> [--limit-requests <n>] [--limit-usd <x>]` | Upsert a quota window |
| `quota:tick --provider <p> [--model <m>] [--requests <n>] [--usd <x>]` | Manual usage increment |
| `quota:show` | All windows with headroom and reset time |

## Tasks

| Command | Effect |
|---|---|
| `task:new --repo <r> --title <t> --class <c> --arm tri\|control [--issue <n> \| --pr <n>] [--kind implement\|pr_review\|research\|ops] [--base <sha>] [--branch <b>] [--worktree <path>] [--owner <id>] [--priority <n>] [--due <iso>] [--parent <task>] [--sibling <task>]` | Insert task, status `submitted`, print id |
| `task:show <id>` | Task, runs, verdicts, tests, escalations |
| `task:close --task <id> --outcome first_pass\|revised\|failed\|abandoned [--pr <url>] [--human-edits <n>] [--no-tests] [--note ...]` | Close gate, see state machine |
| `task:resolve --task <id> [--retry-authorized] --note ...` | Resolve open `halt` escalations, task back to `working`, records intervention |
| `task:reject --task <id> --note ...` | Architect refuses the brief |
| `board [--owner <id>] [--status <s>]` | Table of open tasks, `input_required` first |

## Runs

| Command | Effect |
|---|---|
| `preflight --worktree <p> --provider <p> [--model <m>] [--public] [--allow-dirty] [--strict]` | Guards, exit 2 or 4 on refusal |
| `run:start --task <id> --agent <a> [--adapter <x>] [--provider <p>] [--model <m>] [--public] [--no-preflight]` | Limit and quota gates, insert run, print run id |
| `run:launch --task <id> --agent <a> --prompt-file <f> [--detach]` | `run:start` plus adapter spawn plus watchdog; the one command an orchestrator needs |
| `run:end --run <id> [--exit <code>] [--tokens-in <n>] [--tokens-out <n>] [--cost <x>] [--summary ...]` | Post run guards, files touched, status |
| `watch --run <id>` | Watchdog process, started by `run:launch` |
| `ingest --events <file> --task <id> --run <id>` | Replay normalized events into the ledger and quota |
| `msg --task <id> --kind <k> --from <a> --to <b> --body <file\|text>` | Insert agent message |
| `artifact --task <id> [--run <id>] --kind <k> --path <p>` | Insert artifact with sha256 and bytes |

## Review

| Command | Effect |
|---|---|
| `review:brief --task <id> --reviewer <agent> [--issue-file <f>]` | Write the blind reviewer brief |
| `verdict --task <id> --run <id> --reviewer <agent> --provider <p> --model <m> --file <verdict.json> [--challenge]` | Validate and store, exit 5 on schema failure, exit 3 on challenge limit |
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
3. For a run: `pid.txt` present and process alive; `done.marker` present; `exit.txt` value; `events.jsonl` last event type and age; `out.txt` last non empty line with secrets redacted; watchdog escalation rows; quota windows for the run's provider and whether any is exhausted; elapsed against `wallclock_s`.
4. For a task: attempts used, spend used, open escalations, the derived `next_action`.
5. For `--all`: every `running` run older than `stall_s` with no recent event, every `input_required` task, every quota window at or above 90 percent.

Probable cause is chosen by rule: quota exhausted and last event is a model call → `quota`; process dead, no `done.marker`, no `exit.txt` → `killed externally or machine slept`; last event is a tool call with no result → `tool hang`; elapsed past the wall clock with no escalation → `watchdog missing`. Output ends with the exact `cortexctl` command that resolves the state when one exists.
