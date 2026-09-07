# Changelog

## 0.1.0 (unreleased)

Initial release. SQLite ledger, hard limit state machine, guards, blind
review protocol, and controlled measurement harness for agents run under
Claude Code, Codex, or OpenCode.

### Modules

- `bin/cortexctl.mjs`: CLI entry point and command dispatch.
- `src/db.mjs`, `src/schema/*.sql`: schema, migrations, dialect map.
- `src/config.mjs`: configuration resolution and defaults.
- `src/ledger.mjs`: insert and select helpers for every table.
- `src/quota.mjs`: provider quota rolling and ticking.
- `src/limits.mjs`, `src/guards/*.mjs`: the state machine and every guard.
- `src/adapters/*.mjs`: the adapter interface, credential boundary, and the
  `fake`, `claude`, `codex`, and `opencode` adapters.
- `src/ingest.mjs`: replays normalized events into the ledger.
- `src/packet.mjs`: the context packet, per task and per board.
- `src/review.mjs`: reviewer brief generation, verdict validation, challenge
  cycle, adjudication, PR triage.
- `src/measure.mjs`: control versus tri comparison, reporting, export.
- `src/doctor.mjs`: diagnoses why a run went dark.
- `src/usage.mjs`: subscription usage snapshots and per task deltas.
- `src/commands/*.mjs`: one file per `cortexctl` command group.
- `plugins/opencode/cortex-ledger.js`: the OpenCode plugin providing the
  authoritative `events.jsonl` for that adapter.
- `prompts/*.md`: builder, reviewer, second opinion, PR triage reviewer, and
  the architect brief template.
- `scripts/run-agent.ps1`, `scripts/wait-agent.ps1`, `scripts/run-agent.sh`:
  low level detached launch and poll, ported for reference; `run:launch` and
  `watch` are the preferred path.
- `scripts/publish-check.mjs`: refuses to publish anything private.
- `community/`: the `cortex-ledger` skill and the `blind-reviewer` and
  `novice-builder` agent templates, in the upstream CortextOS catalog format.
- `examples/`: worked walkthroughs for the issue loop, PR triage, and the
  CortextOS org layout.

### Test counts

196 tests across 19 files under `test/*.test.mjs` (`node --test`), including
`test/e2e.test.mjs`: one scenario driven entirely through the CLI (`runCli`)
with the fake adapter and a temp git repo — control arm (`task:new` through
`task:close`), tri arm (`task:new --sibling` through blind `review:brief`,
`verdict`, `adjudicate`, `task:close`), then `compare`, `packet`, `doctor`,
and `export` against the same task pair. Verified green three consecutive
runs of the full suite (`node --test "test/**/*.test.mjs"`), plus eight more
at `--test-concurrency=8` while investigating the order-dependent flake
noted below — no failure reproduced once the tree was stable.

Requires Node 22.5 or later (`node:sqlite`, zero dependencies) - enforced by
`package.json`'s `engines` field and checked live by `doctor`'s first
finding line.

### Exit codes

Every code in docs/state-machine.md's table has at least one CLI level test
(a real `node bin/cortexctl.mjs ...` child process via `test/helpers.mjs`'s
`runCli`), not only a unit level call into the underlying `src/*.mjs`
function:

| Code | Meaning | Example CLI level test |
|---|---|---|
| 0 | Success | most of the suite |
| 1 | Usage error, bad arguments, missing config | `test/cli.test.mjs` (unknown command, missing required flags, missing `--config` file); `test/tasks.test.mjs` (invalid `--arm`, unknown task id) |
| 2 | Preflight refused | `test/runs.test.mjs` (`preflight --strict` on an untracked file) |
| 3 | Hard limit reached | `test/runs.test.mjs` (`retry_limit`, `budget`) |
| 4 | Quota exhausted or `public_only` | `test/runs.test.mjs` (`quota`); `test/guards.test.mjs` (`public_only`) |
| 5 | Verdict JSON invalid | `test/review.test.mjs` (`verdict (CLI)`: malformed JSON, and well-formed JSON failing schema validation) |
| 6 | Task in a disallowed state | `test/runs.test.mjs` (`run:start` on a terminal task, `task:close` blocked by an open halt escalation) |

### Integration pass (executor F)

- `package.json`: `test` script now uses the quoted glob form
  (`node --test "test/**/*.test.mjs"`) rather than a bare directory
  argument, which this workspace's Node build mis-parses as an entry
  script (see the wave log's tooling NOTE under card A). Added `lint`
  (`node scripts/check-syntax.mjs`), a zero-dependency syntax check
  (`node --check`) over every `.mjs`/`.js` file under `src/`, `bin/`,
  `plugins/`, `scripts/`, `test/`.
- Investigated the order-dependent `test/runs.test.mjs` flake executor D
  observed mid-wave: not reproducible once the tree stabilized (11 full
  runs, 3 sequential plus 8 at `--test-concurrency=8`, zero failures). The
  most likely root cause was still real, if not currently triggered: every
  `run:launch` unconditionally spawned a detached `cortexctl watch` process
  (its own `node:sqlite` connection on the same db file) even when the fake
  adapter had already completed synchronously and written `done.marker`
  before `run:launch` returned - racing that connection's open against the
  very next CLI command's own connection with no busy handling. Fixed at
  the root, not with retries or sleeps: `src/db.mjs`'s `openDb` now sets
  `PRAGMA busy_timeout = 5000` (concurrent access to one SQLite file is a
  real, documented scenario here, not hypothetical), and
  `src/commands/runs.mjs`'s `run:launch` skips spawning the watchdog
  entirely when `done.marker` already exists after the adapter call
  returns - the fake adapter is fully synchronous, so no watcher is ever
  needed for it. The watchdog it does still spawn (for real, detached
  adapters) now also forwards `--config` so it enforces the same
  `stall_s`/limits the run started under, instead of whatever config a
  bare `cwd` lookup happens to find.
- Cross module seams unified: `src/ingest.mjs` and `src/review.mjs` now
  call `escalate()` from `src/limits.mjs` instead of `insertEscalation` +
  `setTaskStatus` directly, so halt-to-`input_required` semantics (and
  leaving a terminal task's status alone) live in exactly one place.
  `src/doctor.mjs` no longer keeps its own copy of the secrets patterns; it
  imports `redact` from `src/adapters/credential-boundary.mjs`, which now
  itself re-exports its `PATTERNS` from `src/guards/secrets-scan.mjs` (the
  single canonical, docs/guards.md-ordered list) rather than keeping a
  second, slightly different copy. `checkQuota`'s `public_only` failure
  detail now literally starts with `public_only:` (escalation `reason`
  stays `quota`, matching the documented enum; the CLI's stderr line still
  says the literal word `public_only`, unchanged).
- `run:launch` already accepted and forwarded `--adapter`/`--provider`/
  `--model` (it shares `run:start`'s gate logic) - confirmed against
  `test/runs.test.mjs`'s existing coverage rather than needing a code
  change; docs/cli.md's own signature line for `run:launch` just doesn't
  list those flags (see Known doc mismatches below).
- Added the one command docs/cli.md listed that did not exist yet:
  `purge --task <id> --confirm` (test cleanup only - deletes a task and
  every row across the other task-scoped tables that reference it,
  children before the task row itself, since `foreign_keys = ON`). Added
  `--confirm`, `--board`, `--all`, `--guards`, `--reviewers` to
  `bin/cortexctl.mjs`'s `BOOLEAN_FLAGS` set so those documented bare flags
  never risk swallowing a following token as their value. Every other
  command and flag docs/cli.md names already existed and already worked.
- Windows readiness re-audited: no `/tmp` literals, no `chmod`, no
  `shell: true`, no shell command built via a template string, every
  `spawn`/`spawnSync`/`execFileSync` call already used array args with
  explicit `cwd`/`path.join`, and both `process.kill(-pid, ...)` call sites
  (`src/adapters/spawn.mjs`, `src/adapters/runner.mjs`) were already
  guarded by a `process.platform === 'win32'` branch using `taskkill`
  first. `scripts/run-agent.ps1` and `scripts/wait-agent.ps1` exist
  alongside `scripts/run-agent.sh`, and nothing under `src/`, `bin/`, or
  `plugins/` imports either `.ps1` file.
- `test/e2e.test.mjs` added (see Test counts above).

### Known limitations (open questions carried forward)

Everything below is a wave log `OPEN QUESTION` that is still open after the
integration pass - a documented, conservative choice per the data contract
rule, not a defect:

- `src/adapters/codex.mjs`'s NDJSON item-event parsing (`item.started`/
  `item.completed`, `item.type` values) is this kit's best reconstruction
  of docs/adapters.md's prose, not a byte-for-byte port of a real Codex CLI
  capture - `test/fixtures/codex-exec.jsonl` should be revisited against a
  real capture when one is available.
- `tool.result.ms` (docs/adapters.md's normalized event example) is only
  ever populated for OpenCode-sourced events; Claude Code's `stream-json`
  and Codex's `exec --json` never report a tool's own execution duration,
  so `claude.mjs`/`codex.mjs` omit the field rather than fabricate it.
- A board packet (`packet --board`) cannot insert an `artifacts` or
  `agent_messages` row the way a task packet does, because both tables'
  `task_id` column is `NOT NULL` and a board packet has no task - it only
  writes `packet.json`/`packet.md` to disk. A nullable `task_id` or a
  synthetic "board" task row would close this gap in v0.2.
- There is no `task:abort` command. `intervene --kind abort` only records
  the human_interventions row (per its one-line docs/cli.md description);
  it does not itself transition the task. `task:close --outcome abandoned`
  remains the only documented path from `input_required` to `canceled`.
- The reviewer-precision/triage-note finding-matching heuristic (exact
  file + line + first-60-characters-of-claim) and `compare`'s tie-break
  rule (a tie on both cost and escaped defects reports `tri` as the
  winner) are both arbitrary choices made in the absence of a documented
  rule; worth revisiting once real reviewer output exists.
- Upstream `grandamenium/cortextos` community skill/agent template
  structural conventions (frontmatter keys, section headings, `config.json`
  field names) were verified from clean WebFetch captures, but SOUL.md and
  HEARTBEAT.md's exact upstream prose was not independently verified
  byte-for-byte (WebFetch paraphrases prose content).
- `community/catalog.entry.json`'s `source`/`author` fields still use the
  placeholder repository name/handle pending the owner's actual decision
  (owner gate list items 3 and 5).
- Owner gate items 1, 2, 3, and 4 (Phase 1a backlog switch, OpenCode Go
  purchase, repository public flip and upstream PR, retry-semantics
  confirmation) remain un-shipped pending Aundre's go-ahead, per the wave
  todo's "Owner gate list".

### Doc mismatches found (report only - `docs/*.md` is not edited by this
pass)

- `docs/cli.md` line 33: `run:launch`'s signature only lists
  `--task <id> --agent <a> --prompt-file <f> [--detach]`, but the command
  already accepts and forwards every `run:start` flag
  (`--adapter <x> --provider <p> --model <m> --public --no-preflight`),
  which README.md's quick start already assumes.
