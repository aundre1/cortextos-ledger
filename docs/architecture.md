# Architecture

`cortextos-ledger` is the task board contract that CortextOS does not have. It is a durable ledger, a state machine with hard limits, guards against the failure modes that actually destroy work, a blind review protocol, and a controlled measurement harness. It runs under any harness that can execute a shell command: Claude Code, Codex CLI, OpenCode, or a plain cron.

## What it is not

It is not an orchestrator, not a daemon, not a message bus, not a memory system, and not a model router. CortextOS owns orchestration, heartbeat, inbox messaging, and memory. A2A owns cross machine transport later. This kit owns the record of what was asked, who did it, what it cost, whether it was reviewed, whether the review was right, and whether a limit fired.

## Components

| Component | Responsibility | Entry point |
|---|---|---|
| Ledger | Eight core tables plus quota, interventions, migrations. SQLite in v0.1, same DDL on Postgres in v0.2 | `src/db.mjs`, `src/schema/*.sql` |
| State machine | Task and run transitions, all five hard limits enforced in code, escalation on every breach | `src/limits.mjs` |
| Guards | Preflight (dirty worktree, secrets, quota), runtime (wall clock, stall), post run (files touched, test edits, tool failure) | `src/guards/*.mjs` |
| Adapters | Uniform `run()` over Claude Code, Codex, OpenCode, and a fake; credential boundary on every spawn | `src/adapters/*.mjs` |
| Context packet | Compact boot brief per task or per board, JSON and markdown | `src/packet.mjs` |
| Review | Reviewer brief generation without builder reasoning, verdict schema validation, adjudication, one challenge cycle | `src/review.mjs` |
| Measurement | Control arm tagging, `compare`, `report`, `export` | `src/measure.mjs` |
| Doctor | Explains why a run went dark | `src/doctor.mjs` |
| Usage | Subscription usage snapshots and per task deltas | `src/usage.mjs` |
| Ingest | Replays `events.jsonl` from the OpenCode plugin or adapter streams into the ledger | `src/ingest.mjs` |
| CLI | `cortexctl` wraps everything above | `bin/cortexctl.mjs` |
| Community | Skill and agent templates in the upstream CortextOS catalog format | `community/` |

## Data flow

1. An architect (human or agent) opens a task: `cortexctl task:new`. Row in `tasks`, status `submitted`.
2. Preflight runs before any agent starts: worktree clean, no secrets in the tree, provider quota available. Refusal writes an `escalations` row and exits non zero. Nothing is launched.
3. `cortexctl run:start` checks attempt and spend limits, moves the task to `working`, inserts `task_runs`, and returns the run id.
4. The adapter launches the harness detached, with the credential boundary applied, writing `events.jsonl`, `out.txt`, `exit.txt`, `done.marker` into the run's out dir. The watchdog polls: wall clock breach or stall kills the process tree and writes an escalation.
5. `cortexctl run:end` records exit, tokens, cost, files touched. Post run guards flag test edits and tool failure streaks.
6. `cortexctl ingest` replays events into `task_runs`, `cost_usage`, `agent_messages`, `artifacts`.
7. Tri arm only: `cortexctl review:brief` writes a reviewer prompt from the ledger that contains the issue, the base commit, and the diff, and nothing the builder wrote about its reasoning. The reviewer runs as a separate agent, read only, different provider. `cortexctl verdict` validates the verdict JSON against the schema and stores it with `blind = 1`. A second verdict on the same task is refused unless it is the single allowed challenge cycle.
8. `cortexctl test` records suite results. `cortexctl task:close` sets outcome. A human runs `cortexctl adjudicate` to split findings into real and noise. Without adjudication the ledger is decorative; `report` says so when adjudication is missing.
9. `cortexctl packet` emits the boot brief for whichever harness picks the task up next. `cortexctl compare` produces the tri versus control comparison.

## Runtime layout

```
<runs>/<task-id>/
  brief.md                 architect brief (tri and control arms)
  builder/
    events.jsonl  out.txt  exit.txt  done.marker  elapsed_ms.txt  pid.txt
    patch.diff    reasoning.md
  reviewer/
    events.jsonl  out.txt  exit.txt  done.marker  verdict.json
  packet.json  packet.md
```

The reviewer's allowed directories never include `builder/`. Blindness is a filesystem property first and a prompt instruction second.

## Configuration

Resolution order: `--config <path>`, then `CORTEX_LEDGER_CONFIG`, then `./cortex-ledger.json`, then built in defaults. Paths in the config are absolute or relative to the config file. No path in the repository may reference a specific user's home directory.

```json
{
  "db": "./.cortex/ledger.db",
  "runs": "./.cortex/runs",
  "limits": {
    "builder_attempts_max": 3,
    "challenge_cycles_max": 1,
    "wallclock_s": 5400,
    "spend_usd": 5.0,
    "files_touched_max": 10,
    "stall_s": 900
  },
  "test_patterns": ["**/*.test.*", "**/*_test.*", "**/__tests__/**", "**/tests/**", "**/spec/**"],
  "providers": {
    "google": { "windows": [{ "kind": "day", "limit_requests": 20 }] },
    "opencode-go": { "windows": [{ "kind": "5h", "limit_usd": 12 }, { "kind": "week", "limit_usd": 30 }, { "kind": "month", "limit_usd": 60 }] },
    "nvidia": { "windows": [{ "kind": "minute", "limit_requests": 40 }], "public_only": true }
  }
}
```

`builder_attempts_max` counts attempts, not retries. Three attempts means one initial run and two retries. The fourth `run:start` for the builder agent on one task is refused with exit 3. This resolves the ambiguity in the original run protocol.

Each entry in a provider's `windows` array is itself an enforced ceiling, not documentation: `run:start`'s quota gate, `ingest`, `quota:tick`, and `quota:show` all read it directly (via `provider_quota` rows seeded and kept in sync from the config, `src/quota.mjs`'s `syncConfigQuota`) with no `quota:set` call required. `quota:set` remains the way to override one of these windows for a single deployment -- once set, its row wins over the config for that (provider, model, window kind) permanently, until `quota:set` is used again; see `docs/guards.md` "Provider quota ceilings: config vs. `quota:set`" for the exact precedence rule.

An optional `"tools"` object overrides how a harness or `gh`/`npm` binary is found on Windows, where an npm-installed harness resolves only to a `.cmd` shim that `shell: false` cannot exec directly:

```json
"tools": { "gh": ["C:/tools/gh.exe"] }
```

See `docs/adapters.md` "Windows command resolution" for the full resolution rule set and precedence; this key is validated (a non-empty array of non-empty strings per tool) but otherwise optional and empty by default.

## Portability

Node 22.5 or later, because the ledger uses `node:sqlite` with zero dependencies. Windows is the first class target (PowerShell scripts alongside POSIX shell scripts). CI runs on `windows-latest` and `ubuntu-latest`. Process tree kill uses `taskkill /T /F` on Windows and process group signals elsewhere.

## Relationship to upstream CortextOS

CortextOS selects a harness per agent through the `runtime` field in the agent's `config.json` (`claude-code`, `codex-app-server`, `opencode`, `hermes`). This kit does not replace that. An agent booted by CortextOS in its identity folder runs `cortexctl packet --task <id>` first and `cortexctl run:start` before work. The community artifacts in `community/` package that behaviour as a skill and two agent templates in the upstream catalog format. The ledger database can live at `orgs/<org>/.cortex/ledger.db`, inside the folder CortextOS already gitignores.

## Relationship to A2A

Task states use the A2A v1.0 vocabulary in lowercase: `submitted`, `working`, `input_required`, `completed`, `canceled`, `failed`, `rejected`. `auth_required` is reserved and unused in v0.1. When A2A edges arrive, a task row maps to an A2A Task without renaming anything.

## Decisions locked for v0.1

- SQLite via `node:sqlite`, no native dependencies. `better-sqlite3` fallback is a v0.2 issue.
- Ids are application generated text (`t_`, `r_`, `m_`, `a_`, `v_`, `s_`, `c_`, `e_`, `q_`, `h_` prefixes plus 26 character time sortable random). Timestamps are ISO 8601 UTC strings.
- One agent per model. An agent definition binds a provider and a model; the control arm is its own agent (`solo`), never the builder with an override.
- The architect never receives raw diffs or logs, only envelopes: packet, verdict summary, compare output.
- Nothing merges autonomously. The adapters deny push, merge, hard reset, branch delete, and `gh pr merge` at the harness permission layer.
