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

### Autonomy layer (docs/autonomy.md, shipped default off)

Agents can now build on their own from stated goals and measured outcomes,
share ideas with each other, learn from adjudications and retros, and suggest
routing and tooling changes - all inside the existing hard limits, guards,
and quotas, and all off by default (`config.autonomy.enabled: false`).
Turning it on is a deliberate, logged act; nothing here changes routing,
prompts, or config without a human command, and autonomous merges do not
exist at any dial setting.

- New tables (`src/schema/003-v02-autonomy.sql`): `proposals`,
  `proposal_reviews`, `lessons`, `policy`, `loop_ticks`, with ledger helpers
  in `src/ledger.mjs` following the existing insert/list/get/update-status
  style, plus a shared `ensureSyntheticTask` for the `_proposals`, `_goals`,
  and `_loop` synthetic per-business tasks that anchor cost and intervention
  rows with nowhere else to attach.
- `src/goals.mjs`, `src/commands/goals.mjs`: the private goals contract
  (`config.goals`, never checked in populated - see
  `examples/cortex-goals.example.json`), `ledger:<report field>` metric
  sourcing from `src/measure.mjs`'s `report()` (which gained `cost_per_task`
  and `escaped_defects` per class alongside the existing fields), and
  `goals:show` / `goals:set`.
- `src/proposals.mjs`, `src/commands/proposals.mjs`: `propose`,
  `proposal:review`, `proposal:list`, `proposal:approve`, `proposal:reject`.
  An agent may never review its own proposal. Approval converts through the
  same `insertTask` path `task:new` uses. `canAutoApprove` implements the
  autonomy dial exactly, including that policy and tooling proposals are
  never auto approved regardless of the dial.
- `src/lessons.mjs`, `src/commands/lessons.mjs`: `lesson:add`, `lesson:list`,
  `lesson:retire`, and `selectForPacket`, the only path by which a lesson
  changes behaviour. `packet` now carries a `lessons[]` field and a markdown
  "Lessons" section after the next action; `review:brief` carries reviewer-
  or-all lessons after the issue text. `adjudicate` gained `--lesson` to
  draft one in the same call.
- `src/retro.mjs`, `src/commands/retro.mjs` (`retro`): reads the ledger for
  every pattern in docs/autonomy.md's table (repeated guard firings, low
  reviewer precision, control-matches-tri and tri-catches-more arm
  comparisons, an unaddressed goal gap, a repeating tool failure, a quota
  window at its limit) and drafts lessons/proposals without duplicating an
  identical open one on a second run. Never changes config, prompts, or
  routing.
- `src/policy.mjs`, `src/commands/policy.mjs`: `policy:apply`,
  `policy:revert`, `policy:list`. `policy:apply` re-computes its supporting
  run count from the ledger at apply time (never trusting a count carried on
  the proposal) and refuses under 20 with exit 6. `run:start` now consults
  the active policy for the task's class before falling back to
  `config.agents`.
- `src/loop.mjs`, `src/commands/loop.mjs` (`loop`): the heartbeat body a
  CortextOS agent template or a cron calls. One tick executes an
  already-assigned action through the existing commands (`run:launch`,
  `review:brief`, `run:end`, `ingest` - the same commands a human would run,
  spawned the same way `test/helpers.mjs`'s `runCli` does), otherwise drafts
  or reviews one proposal through the agent's adapter (`prompts/proposer.md`,
  `prompts/proposal-reviewer.md`), and always records a `loop_ticks` row.
  `doctor --all` now reports each agent's last tick; `report --loop` adds a
  ticks/actions/proposal-spend section.
- `examples/cortex-goals.example.json`, `examples/autonomy-loop.md`: the
  goals contract template and a worked walkthrough of turning the dial from
  off to a small amount of autonomous building.


### Windows verification (Node 24.14, 2026-09-07)
- node:sqlite is now loaded lazily behind a scoped emitWarning filter (`loadSqlite`, `sqliteAvailable` in src/db.mjs), so the ExperimentalWarning never reaches stderr on any Node version; on Node 24 it was printed synchronously at load and broke the one line stderr contract on Windows.

### Review round 1 fixes (executor H)

Fixes for the five findings recorded in `.claude/tasks/PLAN-REVIEW-LOG.md`
(F1-F5), each with a new regression test:

- **F1 (blocker, atomic limit gates)**: `doRunStart` (`src/commands/runs.mjs`),
  `storeVerdict` (`src/review.mjs`), and proposal approval
  (`src/proposals.mjs`) now re-check their ledger gates and perform their
  inserts inside a single `BEGIN IMMEDIATE` transaction (new
  `withImmediateTransaction` helper, `src/db.mjs`), with `seq`/
  `challenge_seq` assignment moved inside it, closing a check-then-insert
  race between concurrent processes. Preflight's git/filesystem work still
  runs before the transaction opens. Also fixed a `PRAGMA` ordering bug in
  `openDb()` (`busy_timeout` must be set before `journal_mode = WAL`) and a
  gate-recheck bug where a task's first `retry_limit` halt escalation
  incorrectly blocked all later `run:start` attempts with exit 6 instead of
  a fresh exit 3 re-check (`blockingOpenHalts`). Test:
  `test/concurrency.test.mjs` (12 concurrent `run:start` processes against
  one task, `builder_attempts_max=3`, asserting exactly 3 successes, seq
  1/2/3 with no duplicates, and no `SQLITE_BUSY`/"database is locked").
- **F2 (blocker, one launch path)**: `src/adapters/runner.mjs` tees every
  adapter's child stdout line by line through the adapter's own
  `createStreamParser()` into `events.jsonl` live, for every adapter
  including `fake` by default (`--sync` is now the opt-in exception for the
  e2e/loop fixtures that need a synchronous fake run). `claude.mjs`,
  `codex.mjs`, `opencode.mjs`, and `fake.mjs` all gained
  `createStreamParser()`; `parseStream()` is now a thin wrapper over it.
  `config.adapters.<name>.{cmd,argsPrefix}` overrides let tests stand a stub
  harness in for the real CLI. Test: `test/launch-real-path.test.mjs` (stub
  `claude`/`codex`/`opencode` harnesses driven through the real, non-`--sync`
  `run:launch` path).
- **F3 (major, redaction at rest)**: every line written to `out.txt` passes
  through `redact()` before it hits disk, not only after the run finishes.
  Test: `test/runner.test.mjs` (an `sk-ant-` style key), plus
  `test/launch-real-path.test.mjs` (a `ghp_` style key printed to stderr by
  each stub harness).
- **F4 (major, OpenCode isolation)**: `run:launch` computes and creates a
  per-agent OpenCode data directory (`XDG_DATA_HOME`, and `LOCALAPPDATA` on
  win32) so two OpenCode processes never deadlock on a shared database. New
  `config.opencode_serial` dial (default `false`): when `true`, `run:start`
  for adapter `opencode` refuses (exit 6, reason `opencode_serial`) while
  any `task_runs` row anywhere is `running` with `adapter = 'opencode'` -
  tracked via a new `task_runs.adapter` column
  (`src/schema/004-v02-run-adapter.mjs`). Test:
  `test/opencode-isolation.test.mjs`.
- **F5 (minor, exit.txt precedence)**: `runner.mjs` writes `exit.txt` only if
  it does not already exist, so a watchdog kill's `137` always wins over the
  runner's own, later `child.on('close')` handler. Test:
  `test/runner.test.mjs`.

Doc mismatch (not edited - see "Doc mismatches found" below): docs/cli.md's
`run:launch` line is also now missing `--adapter`/`--provider`/`--model` (a
pre-existing gap, see below) and the new `--sync` flag.

### Review round 2 fixes (executor I)

This pass covers finding R2-1, the one assigned to this executor; R2-2 is
tracked separately and is not addressed here.

- **R2-1 (blocker, watchdog kill was a no-op on real launches)**: `doRunStart`
  (`src/commands/runs.mjs`) never persisted the harness's OS pid to
  `task_runs.pid` - only `<outDir>/pid.txt` (written by
  `src/adapters/runner.mjs`) ever got it. `src/guards/watchdog.mjs`'s
  `tick()` calls `killTree(run.pid)` on a stall or wall clock breach, which
  silently does nothing when `pid` is falsy: the ledger row moved to
  `halted`/`stalled` while the actual process kept running. Fixed at both
  layers:
  - `run:launch` now polls `<outDir>/pid.txt` for up to 3s (50ms steps, no
    fixed sleep) right after `launchDetached()` and writes it to
    `task_runs.pid` as soon as it appears (`pollPidFile`, new in
    `src/adapters/spawn.mjs`). If it never appears in time, `pid` is left
    null - the watchdog's own fallback (next bullet) still covers it - and a
    `cortexctl: warn: pid.txt not found within 3s` line goes to stderr
    without breaking the one-line stdout contract (this is a zero-exit
    path).
  - `tick()` now resolves the pid defensively before killing: `run.pid`,
    falling back to reading and parsing `<outDir>/pid.txt` itself
    (`readPidFile`, also new in `src/adapters/spawn.mjs`) when `run.pid` is
    null. Whichever pid is found is persisted to `task_runs.pid` in the same
    `UPDATE` that records the halt/stall. If no pid can be resolved at all,
    `halted_reason` gets a `;pid_unknown` suffix (so `cortexctl doctor` can
    say so) and the escalation is still written either way.
  - `src/adapters/runner.mjs` already wrote `pid.txt` as the very first
    thing after a successful `spawn()`, before attaching any stdout/stderr
    listeners or the timeout timer - confirmed, no change needed there.
  - Test: `test/watchdog-kill.test.mjs` (new) launches a real, long-lived,
    hung child process through the actual `run:launch` path (a stub
    `claude` adapter command, `node -e "setInterval(()=>{},1000)" --`, that
    never emits a stream event and never exits on its own) and asserts
    against the real OS process: `run:launch` alone already persists
    `task_runs.pid`; `tick()` on a stall breach kills it and
    `task_runs.status`/`pid` land correctly; the same with `task_runs.pid`
    forced to null first, proving the `pid.txt` fallback path; and the same
    again for a wall clock breach. Every case polls
    `process.kill(pid, 0)` until it throws `ESRCH`, with an `afterEach` that
    force-kills any child a failed assertion left running.

### Test counts

251 tests across 30 files under `test/*.test.mjs` (`node --test`), including
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

### E2-3: parse the real `opencode run --format json` stream (executor V)

A real Windows run (`opencode run --format json --agent builder --model
nvidia/moonshotai/kimi-k3`, OpenCode 1.18.27, exit 0, 46s) exposed that
`opencode.mjs`'s `createStreamParser()` only ever understood its own
already-normalized `events.jsonl` shape: every real raw line carries a
`sessionID`, so the parser's fallback branch turned all six of them into a
duplicate `session.start` and produced no token, cost, or tool data at all
for a run that spent about 59k input tokens. `createStreamParser()` now
translates the real raw shapes too (`step_start`, `tool_use`, `step_finish`,
`text`, `error` - verified from `sst/opencode` tag `v1.18.27`,
`packages/opencode/src/cli/cmd/run.ts`'s `emit()` and
`packages/schema/src/v1/session.ts`'s `Part` schemas; see docs/adapters.md
"opencode: parsing the real run --format json stream (E2-3)" for the full
citation trail): exactly one `session.start` (deduped across every raw
line's `sessionID`, not one per line); `step_finish` becomes a `message`
event with `tokens_in`/`tokens_out`/`tokens_reasoning`/`cache_read`/
`cache_write`/`cost_usd` (`0` recorded as a real reported value, `usage_source:
'reported'`, never coerced to null); a completed or errored `tool_use`
becomes both `tool.call` and `tool.result` (tool name, `call_id`, `ms` from
`state.time.start/end`, no raw input/output body, mirroring `claude.mjs`'s
own tool-result summarization); a new `error` event type (`severity: 'halt'`,
`statusCode`, redacted `message`) for the two real error shapes observed (a
410 Gone for a retired model, a 401 Unauthorized) - informational only, the
run's actual exit code stays authoritative; any other raw type is dropped
but counted as `unparsed_lines` on a synthesized `session.end` (`flush()`
now sums `tokens_in`/`tokens_out`/`cost_usd` across every `step_finish` seen,
since this raw stream never reports its own totals - the reason the plugin
exists at all). `run()` patches the synthesized `session.end`'s
`exit_code`/`elapsed_ms` (both `null` from the parser alone) from the real
spawned process, the same pattern `codex.mjs` already uses for its own
NDJSON `session.end`. The plugin-authoritative, already-normalized path (D1/
D2's `agent.fallback`, and the pre-existing `opencode-events.jsonl` fixture)
is untouched. New fixture: `test/fixtures/opencode-run.real.jsonl` (the real
capture, every absolute path replaced with `<worktree>` - session ids,
timestamps, and token numbers are byte-identical to the real run). Tests: 9
new in `test/adapters.test.mjs` (session.start dedupe, the two `message`
events' exact token/cost numbers, the `read` tool's `tool.call`/`tool.result`
pair and its `ms`, the synthesized `session.end`'s totals and
`unparsed_lines`, the 410/401 `error` events, an unknown-type counter case,
and D2's fallback text still working alongside the new JSON path); 1 new in
`test/ingest.test.mjs` (the real fixture parsed end to end and ingested,
asserting one `cost_usage` row with `tokens_in` 58646, `tokens_out` 145,
`cost_usd` 0). `npm test`: 351/351. `node scripts/check-syntax.mjs`: 100
files, 0 failures. `node scripts/publish-check.mjs`: clean.

### Real-run regressions from E2-3: session.end's real exit/elapsed, tool args relative to cwd

A real Windows run at commit `ec3dc36` (ingest correctly recorded tokens_in
58698, tokens_out 125, 1 tool call, 2 requests - the E2-3 parser itself
worked) exposed two regressions:

1. **`events.jsonl`'s on-disk `session.end` never carried the real
   `exit_code`/`elapsed_ms`** (`"exit_code":null,"elapsed_ms":null` on
   disk), where before `ec3dc36` it always had real values. Root cause,
   `src/adapters/runner.mjs`: once *any* event of type `session.end` had
   been appended live (from any adapter's `createStreamParser().push()` or
   `flush()`), the runner treated that as "nothing more to do" and skipped
   its own end-of-process fallback that knows the real exit code and
   elapsed time - it never checked whether the session.end it already saw
   actually carried real values. This was not opencode-specific: `codex.mjs`'s
   `turn.completed` session.end has never carried `exit_code` or
   `elapsed_ms` at all, and `claude.mjs`'s final `result` line carries a
   real `exit_code` but calls its own timing field `duration_ms`, never
   `elapsed_ms` - both adapters' *real* production launches (which always go
   through `runner.mjs`, per review round 1's "one launch path") have
   silently had this gap since that path was introduced; it surfaced now
   only because this was the first real, non-fixture-driven capture.
   Fixed: `runner.mjs` now tracks the most recently appended `session.end`
   event object and, at the real process's `close`, appends one more
   corrected `session.end` line (preserving every other field the original
   carried - tokens, cost, session_id, ...) whenever its `exit_code`/
   `elapsed_ms` disagree with what the runner itself just observed.
   `ingest`/any consumer that wants "the" session.end already takes the
   *last* line of that type in the file, so the corrected line wins. Test:
   3 new in `test/runner.test.mjs`, one per adapter, each spawning a real
   stub harness through the real `runner.mjs` binary and asserting the
   final on-disk `session.end` line's `exit_code` matches the real spawned
   process's and `elapsed_ms` is a real number.
2. **A tool's `args_summary` could contain the operator's absolute worktree
   path verbatim** (a `D:\...` path on the reference Windows run, from
   `read`'s own `state.input.filePath`) - personal information landing in
   `events.jsonl`. Fixed with a new shared helper,
   `relativizeToCwd(value, cwd)` (`src/adapters/credential-boundary.mjs`):
   recurses through an object/array, rewriting any string equal to or
   starting with `cwd` to a `.`-relative one. Wired into all three real
   adapters' tool-call/tool-result summarizers (`claude.mjs`'s and
   `codex.mjs`'s `capSummary`, `opencode.mjs`'s `capText`) and threaded
   through each `createStreamParser({ cwd })`/`parseStream(lines, { cwd })`;
   `runner.mjs`'s `loadParser` now passes the run's own `--cwd` through so
   the real production path is covered too. A falsy/omitted `cwd` is a
   no-op, so every pre-existing caller (every existing unit test included)
   behaves exactly as before. Test: 8 new in `test/adapters.test.mjs`
   (opencode's tool_use path relativized exactly and as a subpath, the real
   fixture relativized end to end, the no-`cwd` case left unchanged) and 8
   new in `test/credential-boundary.test.mjs` (`relativizeToCwd` itself:
   exact match, both path separators, a false-prefix near-miss left alone,
   recursion through nested objects/arrays, the falsy-`cwd` no-op, and
   non-string/object values passed through untouched).

`npm test`: 367/367 (351 + 16 new). `node scripts/check-syntax.mjs`: 100
files, 0 failures. `node scripts/publish-check.mjs`: clean.

### Blocker 1 & Blocker 2: prompt delivery via stdin, archive never delete (executor Y)

Two defects found on the owner's real machine.

**Blocker 1 - `spawn ENAMETOOLONG` launching a review of PR #972 (492
additions).** The reviewer's brief is passed to every adapter as a single
`argv` element; Windows' `CreateProcess` caps a full command line around
32767 characters and the practical `spawn` limit is lower still. Fixed with
a new module, `src/adapters/prompt-delivery.mjs`: `choosePromptDelivery`
picks `argv` (unchanged, pre-existing behaviour) or `stdin`, deterministically
by a fixed 8000-character threshold on every platform, never by the host's
real (and varying) argv limit. Verified from each harness's own source
before choosing `stdin` for all three real adapters (`file` is documented but
unused - see `docs/adapters.md` "Prompt delivery (Blocker 1)" for the full
citation trail): opencode's `resolveRunInput`
(`packages/opencode/src/cli/cmd/run.ts:40-50`, tag `v1.18.27`) returns piped
stdin text whenever the positional `message` is empty; codex's top-level
`exec` `PROMPT` (`codex-rs/exec/src/cli.rs:74-77`, tag `rust-v0.48.0`) reads
stdin when the argument is omitted, while `exec resume`'s own `PROMPT`
(same file, `:97-99`) needs the literal `-` passed explicitly - `codex.mjs`
now does exactly that on the `stdin` path, never bare omission there;
claude's `-p` reads stdin when passed with nothing following it. Every
`buildArgv()` now returns `promptDelivery`/`stdin`/`promptDeliveryEvent`, and
every adapter's `run()` writes `stdin` to the child's real stdin and closes
it when the delivery is `stdin`. The choice is never silent: a
`prompt.delivery` event (`severity: 'info'`, the mode and the prompt's own
character count, never its text) is seeded into `events.jsonl` before the
harness spawns, and `task_runs.prompt_delivery` (new column, migration
`008-v02-prompt-delivery`) records it on the run row from both the
`run:launch` detached path and any adapter's own `--sync` path.

The relay never puts the prompt into *any* process's own argv, including
`runner.mjs`'s own (the detached wrapper `run:launch` spawns, itself a
`child_process.spawn` target and just as exposed to this defect as the
harness). `src/commands/runs.mjs` writes the prompt to a redacted-at-rest
`<outDir>/prompt.txt` (same `redact()` `out.txt` already uses) and passes
only its short path to `runner.mjs` via a new `--stdin-file <path>` flag;
`runner.mjs` reads that file's exact bytes onto the harness's real stdin and
closes it. Tests: `test/adapters.test.mjs` builds argv for a 40000-character
prompt with `platform`/`platformOverride: 'win32'` injected for all three
adapters (codex's resume branch too), asserting no argv element carries the
prompt body and that `promptDelivery`/the seeded event both read `stdin`,
plus a same-length-as-threshold companion proving the pre-existing `argv`
shape is unaffected under it. `test/runner.test.mjs` spawns a real stub
harness through the actual `runner.mjs` binary with a 40000+ character
prompt file and `--stdin-file`, and the stub itself reads stdin to EOF and
reports a sha256 checksum and byte length of what it actually received -
asserted to match the source prompt exactly, proving the full relay end to
end rather than only the absence of the prompt from argv.

**Blocker 2 - `purge` deletes; the owner's instruction is that work must be
archived for later retrieval, never deleted.** New commands `task:archive
--task <id> [--reason ...]` and `task:unarchive --task <id>`
(`src/commands/tasks.mjs`), new columns `tasks.archived_at`/`archive_reason`
(migration `009-v02-archive`). An archived task is excluded from `board`,
`compare`, and every `report` statistic - the identical mechanism (query
filters in `src/measure.mjs`) already used to exclude an unadjudicated task,
not a second parallel one - while `task:show` (prints an `ARCHIVED at ...`
line) and `export` (an `archived_at`/`archive_reason` column) are unaffected:
nothing about the row itself changes, only its membership in the measured
set. `task:archive` refuses (exit 6, reason `task_state` -
`docs/state-machine.md`'s existing "task is in a state that does not allow
the command" code) while any of the task's runs is still `running` -
archiving resolves nothing and kills nothing. It writes a
`human_interventions` row of kind `archive` (added to the documented enum,
`docs/ledger.md`). `purge` stays (test cleanup only) but now refuses (exit
6, reason `not_archived`) any task that is not already archived, and both
its `--confirm` usage message and its `docs/cli.md` row say plainly that it
deletes irreversibly and that `task:archive` is the intended way to set work
aside. Tests: 7 new in `test/archive.test.mjs` - board exclusion and
`task:unarchive` restoring it; the `human_interventions` row and
`task:show`'s archived display; `export` still including an archived task
with its new columns; archiving a task with a run still `running` refused
with exit 6 and the task left exactly as it was; `purge` on a non-archived
task refused with exit 6 (and the task still there afterward), then
succeeding once archived; `purge` without `--confirm` naming `task:archive`
on stderr; an archived task excluded from `compare` (the same "no linked
pair" refusal an unpaired task already gets) and from `report`'s per-class
count.

Docs: `docs/cli.md` (`task:archive`/`task:unarchive` rows, `purge`'s row
rewritten), `docs/state-machine.md` (exit code 6 table entry, new "Archive,
never delete" section), `docs/ledger.md` (`tasks.archived_at`/
`archive_reason`, `task_runs.prompt_delivery`, `human_interventions.kind`
gains `archive`), `docs/adapters.md` (new "Prompt delivery (Blocker 1)"
section with the full citation trail, `claude`/`codex`/`opencode` sections
updated for the threshold), `docs/measurement.md` (new "Archived tasks"
section mirroring the unadjudicated-task exclusion language).

`npm test`: 417/417 (402 + 15 new: 7 archive, 7 adapter prompt-delivery
argv-shape, 1 runner stdin-relay checksum). `node scripts/check-syntax.mjs`:
108 files, 0 failures. `node scripts/publish-check.mjs`: clean.

### Real defect fix: `run:launch --retry` misreading a retried attempt from the previous attempt's stale artifacts

Confirmed real defect from the owner's machine: `run:launch --retry 4 --retry-backoff-s 45` against a rate-limited
lane logged two correct `provider_unavailable` retries, then, on attempt 3, printed a run id and exited 0 almost
immediately even though that attempt's own run directory shows `exit.txt = 1` and an `events.jsonl` holding a
retryable 429 with no successful completion.

Root cause, confirmed by reading the code: every attempt of the same `(task, agent)` writes into the same out dir,
`<runs>/<task>/<agent>/` (`docs/architecture.md`'s runtime layout is per task+agent, not per run). `runner.mjs`
truncates only `out.txt`/`events.jsonl` fresh per run and never touches `done.marker`/`exit.txt`/`elapsed_ms.txt`/
`pid.txt` at all. `waitForDoneMarker` (`src/adapters/spawn.mjs`) therefore found the *previous* attempt's own
`done.marker`, still sitting there, and returned immediately for the *new* attempt; `doRunEnd` (`src/commands/
runs.mjs`) then classified the new run entirely from the old attempt's `exit.txt`/`events.jsonl` on disk at that
moment.

Fixed: `launchAttempt` (`src/commands/runs.mjs`) now calls a new `archivePriorAttempt` (`src/adapters/spawn.mjs`)
right after `doRunStart` returns and before this attempt writes anything into the out dir. It moves - never
deletes, the owner's standing "archive, never delete" rule - every artifact file a previous attempt for this exact
`(task, agent)` left behind (`done.marker`, `exit.txt`, `elapsed_ms.txt`, `events.jsonl`, `out.txt`, `pid.txt`,
`prompt.txt`, and the agent-produced `patch.diff`/`reasoning.md`/`verdict.json`) into `<outDir>/attempts/<previous
run id>/`, recorded on that previous run's own new `task_runs.attempt_evidence_dir` column (migration
`010-v02-attempt-archive.mjs`) so `task:show` can point at it. `waitForDoneMarker` also gained a belt-and-braces
`sinceMs` check (a found marker older than the current attempt's own `started_at` does not count as done) even
though the archiving above already guarantees a clean directory - the same kind of invariant the original defect
silently violated is worth verifying, not just trusting. That check needed its own fix along the way: a strict
`mtimeMs >= sinceMs` intermittently hung `--sync` launches for the full `wallclock_s` timeout, because the gap
between `started_at` (a millisecond-resolution JS `Date`) and the real `done.marker` write can be under a
millisecond in that path - well inside the jitter between `Date.now()`'s clock source and the filesystem's own
`mtime` clock - so a 5 second tolerance was added; it does not weaken the check's real job; a marker that
`archivePriorAttempt` should have archived away is from a categorically earlier CLI invocation, not a same-attempt
race, and is virtually certain to be older than that by far more than 5 seconds. `src/ingest.mjs`'s well-known-artifact lookup now prefers
`attempt_evidence_dir` over `out_dir` when present, so ingesting an archived attempt by its own explicit `--events
<path>` attributes artifacts to the run that actually produced them rather than to whichever attempt is currently
live in the shared directory; `ingest`'s existing per-run idempotency (keyed by `run_id`, not by path) already
means archived attempts can be ingested by path with no double counting, since each is a distinct run id.

A related latent bug fixed as part of the same root cause: the stale `done.marker` also made `run:launch` skip
spawning a watchdog for every retried attempt (the pre-spawn `existsSync(done.marker)` check saw the *old* marker
and concluded, wrongly, that this attempt had already finished synchronously) - a retried attempt was running with
no wall-clock/stall protection at all. Archiving the directory clean before each attempt fixes this for free.

Tests (`test/runs.test.mjs`): two new tests drive the real `run:launch --retry` loop through the real CLI (a real
subprocess, not an in-process call) over the fake adapter's real (non `--sync`) launch path - `src/adapters/
fake-harness.mjs` spawned as its own child process through `runner.mjs`, exactly like a real claude/codex/opencode
harness, since `--sync`'s in-process `run()` overwrites every file unconditionally on every call and cannot
reproduce this defect. The first asserts that a stub harness emitting a retryable 429 on every attempt keeps
retrying to the full budget: exactly `totalAttempts` runs, every one `failure_class = provider_unavailable`, exactly
one `warn` escalation at the end, exit 7, and each earlier attempt's artifacts preserved and readable under
`attempts/<run id>/`. The second chains three fixtures (429, 429, then a clean success, each attempt's own `files`
rewriting the shared fixture file for the next spawn) and asserts exit 0, three runs, and that the live out dir
holds the successful run's own artifacts, not an earlier failed attempt's.

Confirmed pre-fix with a `git stash` cycle (fix files stashed, new tests and the migration file kept aside, run
against HEAD `862e253`): both new tests fail, and the second reproduces the confirmed defect almost exactly as
observed on the owner's machine. Because attempt N's own fixture write races several still-running detached
`runner.mjs` processes writing into the identical shared out dir concurrently (not just a two-attempt stale read -
every prior attempt's `runner.mjs` keeps running in the background, unref'd and unawaited, after the loop has
already moved on), the loop over-fired: **4** run rows were created chasing a 3-attempt success instead of 3, and
the run `run:launch` printed and exited `0` for was itself left on disk as `status: fail`, `exit_code: 1`,
`failure_class: null` - a run:launch exit 0 over a run that never actually succeeded and was not even correctly
classified `provider_unavailable`, matching the owner's report almost exactly (`run:launch` exiting 0 over a run
whose own `exit.txt` is 1). The first test fails on the one assertion pre-fix code has no way to satisfy at all:
`attempt_evidence_dir` is never set and no `attempts/<run id>/` directory is ever created, because the archiving
this fix adds does not exist yet.

Docs: `docs/state-machine.md` ("Provider unavailable" gains a paragraph on per-attempt directory archiving),
`docs/cli.md` (`--retry` row), `docs/ledger.md` (`task_runs.attempt_evidence_dir`), `docs/security.md` (at-rest
table gains the `attempts/<run id>/` path).

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
  confirmation) remain un-shipped pending the owner's go-ahead, per the wave
  todo's "Owner gate list".

### Doc mismatches found (report only - `docs/*.md` is not edited by this
pass)

- `docs/cli.md` line 33: `run:launch`'s signature only lists
  `--task <id> --agent <a> --prompt-file <f> [--detach]`, but the command
  already accepts and forwards every `run:start` flag
  (`--adapter <x> --provider <p> --model <m> --public --no-preflight`),
  which README.md's quick start already assumes. As of review round 1 it is
  also missing the new `--sync` flag (`bin/cortexctl.mjs`'s `BOOLEAN_FLAGS`),
  which opts into the old in-process/synchronous adapter call instead of the
  default detached `buildArgv()` + `launchDetached()` path every adapter
  (fake included) now goes through.
