# Guards

Each guard maps to a failure that happened to a named person in the Agent Architects community. The kit does not quote them; it prevents the repeat.

## Preflight (before any agent starts)

`cortexctl preflight --worktree <path> --provider <p> [--model <m>] [--public] [--allow-dirty]`

| Check | Failure prevented | Behaviour |
|---|---|---|
| Dirty worktree | An unattended agent deleted uncommitted work; one member lost a month | `git status --porcelain` must be empty of tracked changes. Untracked files are listed but allowed unless `--strict`. Refuse with exit 2 and escalation `dirty_worktree` unless `--allow-dirty` is passed, and record the flag in `notes` so the override is visible in the ledger |
| Secrets in tree | Keys placed in agent readable folders were exposed and had to be rotated | Scan tracked and untracked files under the worktree (skip `.git`, `node_modules`, binaries over 1 MB) for patterns: `-----BEGIN [A-Z ]*PRIVATE KEY`, `sk-[A-Za-z0-9]{20,}`, `sk-ant-`, `ghp_`, `github_pat_`, `AKIA[0-9A-Z]{16}`, `xox[abp]-`, `AIza[0-9A-Za-z_-]{35}`, `ya29\.`, `nvapi-`, and any file named `.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`. Report file path and line number only. Never print the matched value. Exit 2 with escalation `secrets` |
| Provider quota | A shakedown died on a 20 request per day quota after one call | Roll windows, check headroom for one request and the projected cost. Exit 4 with escalation `quota` |
| Public only provider | Private repository content sent to a provider restricted to public material | If the provider config has `public_only: true` and `--public` is absent, exit 4 with reason `public_only` |
| Node version | `node:sqlite` missing | Exit 1 with a plain message naming 22.5 |

Preflight is invoked automatically by `run:start` unless `--no-preflight` is passed, and the skip is recorded in the run's `halted_reason` column as `preflight_skipped` so it is never silent.

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
