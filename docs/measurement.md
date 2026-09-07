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

## Public datapoints

When the measured workload is public (for example PR triage on a public repository), `export` output can be published as is; it contains no diff content, only ids, counts, costs, and decisions. Private workloads keep their exports private. The kit ships a `scripts/publish-check` script that refuses to package any run directory, any `reasoning.md`, or any file matching the secrets patterns.
