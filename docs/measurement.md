# Measurement

Every claim about multi agent value in the community is anecdotal or cost based. This is the harness for the first controlled comparison, and it is the reason the ledger exists.

## Design

Every measured task runs twice from the same base commit on separate branches and worktrees.

- Arm A, `tri`: architect brief, builder, blind reviewer, tests, patch.
- Arm B, `control`: agent `solo` (same provider and model as the builder, its own agent definition), same brief, no reviewer, tests, patch.

Run the control arm first, so it is not contaminated by review findings. `task:new --arm control` followed by `task:new --arm tri --sibling <control-task-id>` links them; `compare` uses the link.

## Recorded per arm

| Field | Source |
|---|---|
| First pass success (tests green, no human edit) | `test_results` first row status plus `tasks.human_edits = 0` |
| Revision count | count of builder runs minus one |
| Reviewer findings, real versus noise | `review_verdicts` after adjudication |
| Defects that survived to the patch and were caught by a human | `tasks.defects_escaped` |
| Tokens and cost by model | `cost_usage` grouped by provider and model |
| Elapsed wall clock | sum of run elapsed plus reviewer elapsed |
| Human interventions and what each was | `human_interventions` rows |
| Guard firings | `escalations` rows |

## Commands

`cortexctl compare --issue <n>` or `--pr <n>` or `--task <id>`: prints both arms side by side with the fields above and a one line reading: which arm had fewer escaped defects, at what cost multiple, at what time multiple. It refuses to print a winner when either arm is unadjudicated; it prints `unadjudicated` instead.

`cortexctl report [--class <task_class>] [--since <date>] [--guards] [--reviewers]`: per task class counts, first pass rates by arm, reviewer precision by provider, mean cost and elapsed by arm, guard firings. When a class has fewer than 20 adjudicated runs the report prints `n < 20, not routing grade` beside it. Nothing reads the ledger back to change routing until that threshold is met; this is a rule of the kit, not a suggestion.

`cortexctl export --format csv|json [--table <name>] [--since <date>] --out <dir>`: one file per table, for Grafana, a spreadsheet, or a notebook. This is the observability answer for members who built their own Grafana stacks: the ledger is the source, the dashboard is theirs.

## Promotion criteria (unchanged from Phase 1)

Phase 2 begins only when, across at least two pilot tasks: the tri arm caught at least one real defect the control arm shipped, or the ledger shows it did not and that result is accepted; every hard limit fired correctly at least once under deliberate test (the fake adapter test suite covers this); cost per task in the tri arm is known within 10 percent; no task needed more than one human rescue.

Failing the first criterion is a valid outcome. If three models are no better than one on a task class, the ledger says so and the routing policy later sends that class to a single agent. That is the system working.

## OpenCode Go as the builder lane

`examples/config.opencode-go.json` and `examples/measurement-opencode-go.md`
are a worked configuration and recipe for running this measurement with an
OpenCode Go subscription as the builder lane: `builder` and `solo` on
adapter `opencode`/provider `opencode-go`, `reviewer` and `reviewer_b` each
wired to a different lab so review stays independent.

**Different labs for review.** `docs/review-protocol.md` ("Roles") requires
the reviewer to be "a different lab from the builder" and, in PR triage
mode, requires `reviewer_b` to differ again from both. The example config
puts `reviewer` on `google` and `reviewer_b` on `openai`, leaving builder
and solo the only two agents on the OpenCode Go subscription. Every model
string is left blank with a `_model_note` explaining what belongs there --
the same placeholder convention `community/agents/blind-reviewer/config.json`
uses for its own reviewer model -- because this kit ships no default models
and the operator's actual OpenCode Go catalog, Google access, and OpenAI
access are all account-specific.

**The quota is USD-equivalent, not a token count.** An OpenCode Go plan
grants roughly $12 of usage per rolling 5 hours, $30 per week, and $60 per
month; that shape maps directly onto the `5h`/`week`/`month` window kinds
`src/quota.mjs` already implements, with `limit_usd` 12/30/60
(`docs/architecture.md` "Configuration" shows this exact block). Because the
month window's ceiling is 60 -- the subscription's own monthly equivalent --
`run:start`'s quota gate and `ingest`'s post-hoc check refuse to let this
measurement's OpenCode Go spend exceed the subscription itself; the schema
has no separate field for "ceiling on the whole measurement run", so tying
the enforced ceiling to the real monthly number is the honest way to express
it with the code that exists. Declaring the windows in `cortex-ledger.json`
only documents the intent, though: `checkQuota` (`src/limits.mjs`) reads
`provider_quota` rows from the database, and only `quota:set` creates those
-- the three `quota:set` commands in `examples/measurement-opencode-go.md`
must be run once per ledger before the ceiling is actually enforced.
`limits.spend_usd` is a separate, per-task ceiling on top of that; it sums
every provider's cost for one task, not only OpenCode Go's.

**Cost figures are not comparable across lanes.** A dollar of OpenCode Go
usage is a share of a flat monthly plan, not a per-token bill; a dollar
spent against `google` or `openai` is billed per token against the
operator's own account with no ceiling declared here. `compare`'s cost
multiple and `report`'s mean cost are only a fair comparison provider by
provider, never lane to lane -- reading "OpenCode Go cost $0.40, the reviewer
cost $0.60" as "the reviewer was 1.5x more expensive" mixes a subscription
share with a real charge.

**Telling the lanes apart in the ledger.** Every `cost_usage` row carries
`provider` and `model` (`docs/ledger.md`) plus a `source` column (`plugin |
manual | provider_api`, `src/schema/000-base.sql`) -- `source` records how
the row was produced (an adapter's normal ingest is always `'plugin'`,
regardless of provider, per `src/ingest.mjs`), not which billing lane the
usage came from. There is no ledger column named `usage_source`; that name
only appears inside `codex.mjs`'s own normalized `session.end` events
(`reported` vs `manual`, marking whether Codex actually emitted usage
numbers) and `ingest` does not carry it into the database. To tell OpenCode
Go's subscription-equivalent rows apart from an API-billed reviewer's, join
`cost_usage.provider` (or `task_runs.provider`) against `config.providers`:
a provider with declared `limit_usd` windows is the subscription-equivalent
lane, a provider with none is billed by the operator's own account outside
this kit.

## Public datapoints

When the measured workload is public (for example PR triage on a public repository), `export` output can be published as is; it contains no diff content, only ids, counts, costs, and decisions. Private workloads keep their exports private. The kit ships a `scripts/publish-check` script that refuses to package any run directory, any `reasoning.md`, or any file matching the secrets patterns.
