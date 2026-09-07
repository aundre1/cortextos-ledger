# cortextos-ledger

The task board contract CortextOS is missing: a durable ledger, hard limits,
blind review, and controlled measurement for agents in Claude Code, Codex, and
OpenCode. SQLite to Postgres. Zero dependencies.

## What it prevents

- Uncommitted work destroyed by an unattended agent.
- Runaway runs: an agent that keeps going past the time, spend, or file count
  anyone would have stopped it at.
- Tests edited to pass instead of a bug getting fixed.
- Tools that fail silently and get improvised around instead of reported.
- Agents that go dark for hours with no way to tell what happened.
- Surprise API bills from a subscription harness quietly falling back to a key.
- No record of whether a reviewer's findings were actually right.

Each of these maps to a guard or a hard limit described in `docs/guards.md`
and `docs/state-machine.md`. None of them are enforced by asking an agent
nicely; they are enforced in code, and every breach leaves a row in the
ledger.

## Ten minute quick start

Requires Node 22.5 or later and git. Run these from an empty scratch
directory; nothing here touches a real harness, because it uses the `fake`
adapter shipped for exactly this purpose.

```bash
git init
git commit --allow-empty -m "start"

node bin/cortexctl.mjs init
# schema version: <latest migration>

t=$(node bin/cortexctl.mjs task:new --repo you/example --title "Say hello" \
  --class demo --arm control)
echo "task: $t"

node bin/cortexctl.mjs preflight --worktree . --provider fake

r=$(node bin/cortexctl.mjs run:launch --task "$t" --agent solo --adapter fake \
  --prompt-file /dev/null)
echo "run: $r"

node bin/cortexctl.mjs run:end --run "$r" --exit 0 --cost 0.00 \
  --summary "hello, ledger"

node bin/cortexctl.mjs packet --task "$t"
node bin/cortexctl.mjs doctor --task "$t"
```

`packet` writes `packet.json` and `packet.md` into the run directory:
the compact "where we left off" brief every harness boots from instead of a
wall of history. `doctor` answers "why did my agent go dark" without anyone
reading a transcript. Both work the same way whether the run just happened
or happened three days ago, because both read the ledger, not the process.

To drive a real harness instead of the fake adapter, see `docs/adapters.md`
for the exact command each one runs and `docs/security.md` for what gets
stripped from its environment first.

## How it fits CortextOS

CortextOS owns orchestration, heartbeat, inbox messaging, and memory. This kit
owns none of that. It owns the record of what was asked, who did it, what it
cost, whether it was reviewed, whether the review was right, and whether a
limit fired. An agent that CortextOS boots into an org's identity folder runs
`cortexctl packet --board --owner <me>` on heartbeat and `cortexctl run:start`
before touching a file; `community/` packages that behavior as one skill and
two agent templates in the upstream CortextOS catalog format, installable
without any of this kit's own code entering the upstream repository. See
`docs/architecture.md` and `examples/cortextos-org-layout.md`.

## Hard limits

Five limits are enforced in code, every breach leaves an `escalations` row,
and a limit that can be forgotten is not a limit:

| Limit | Default | Enforced where | Breach |
|---|---|---|---|
| Builder attempts per task | 3 | `run:start` | Exit 3, task `input_required` |
| Challenge cycles per task | 1 | `verdict` | Exit 3, verdict not stored |
| Wall clock per run | 5400s | watchdog, and `run:start` | Process tree killed, run `halted` |
| Spend per task | $5.00 | `run:start` (projected), `ingest` (actual) | Exit 3 at start, escalation at ingest |
| Files touched per run | 10 | `run:end` | Run `halted`, task `input_required` |

Full detail, including the two soft limits and every exit code, is in
`docs/state-machine.md`.

## Model routing rule

One agent binds one provider and one model; changing the model means a new
agent name, never a flag override on an existing one, so a bad result is
always attributable. The reviewer's provider must differ from the builder's,
or the review is not actually independent. The `opencode` adapter refuses any
model string containing `claude` or `anthropic` outright, because Anthropic
subscription OAuth may not be used inside a third party harness; this is a
policy fact the kit encodes rather than leaving to memory. See
`docs/adapters.md` and `docs/security.md`.

## Measurement

Every measured task runs twice from the same base commit: the tri arm
(architect brief, builder, blind reviewer, tests) against the control arm
(one agent, same brief, no reviewer). `cortexctl compare` prints both arms
side by side and refuses to name a winner when either arm is unadjudicated.
`cortexctl report` breaks reviewer precision down by provider and task class,
and says `n < 20, not routing grade` under that threshold; nothing reads the
ledger back to change routing before then. See `docs/measurement.md`.

## Requirements

- Node 22.5 or later (the ledger uses `node:sqlite`; zero npm dependencies).
- git.
- Optional, only for the harness you actually plan to drive: the `claude`,
  `codex`, or `opencode` CLI.

## Status

v0.1. Windows is the first class target; CI runs on both `windows-latest` and
`ubuntu-latest`. SQLite now, the same DDL on Postgres is a v0.2 issue.

## Docs

| Doc | Covers |
|---|---|
| `docs/architecture.md` | Components, data flow, configuration, what this kit is not |
| `docs/state-machine.md` | Task and run states, the five hard limits, exit codes |
| `docs/ledger.md` | Schema, migrations, invariants |
| `docs/guards.md` | Preflight, runtime, and post run guards, and the failure each prevents |
| `docs/adapters.md` | The adapter interface and each harness's exact command line |
| `docs/security.md` | Credential boundary, secrets scan, what the ledger stores |
| `docs/review-protocol.md` | Blind review, the verdict schema, adjudication, PR triage |
| `docs/context-packet.md` | The boot brief every harness reads instead of a transcript |
| `docs/measurement.md` | Control versus tri, `compare`, `report`, `export` |
| `docs/cli.md` | Every `cortexctl` command and flag |
| `docs/community.md` | Packaging the kit as a CortextOS skill and agent templates |

## License

MIT. See `LICENSE`.
