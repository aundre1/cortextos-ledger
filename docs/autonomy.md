# Autonomy layer

The ledger records what agents did. The autonomy layer lets agents decide what to do next, from stated goals and measured outcomes, and lets them talk to each other about it, without a human prompting each step. Every autonomous action stays inside the hard limits, every decision leaves a row, and the human keeps three levers: the autonomy dial, task approval, and policy approval.

## The four behaviours and where they live

| Behaviour | Mechanism | Table or command |
|---|---|---|
| Building on their own from goals and metrics | The loop reads the goals contract, the board, and recent lessons, and drafts a proposal or picks up an approved task | `goals`, `proposals`, `cortexctl loop` |
| Sharing ideas | Proposals are authored by one agent and reviewed by others with support or oppose verdicts and notes | `proposals`, `proposal_reviews` |
| Learning from each other | Lessons are extracted from adjudications, escalations, and retros, then injected into every packet for the same task class | `lessons`, packet `lessons[]` |
| Suggesting how to scale and what to build | The retro reads the ledger and emits candidate lessons, routing policy proposals, and tooling proposals per business | `cortexctl retro`, `proposals` with `kind = policy` or `tooling` |

## Goals contract

A JSON file named by `config.goals` (default `./cortex-goals.json`). The kit ships `examples/cortex-goals.example.json` with placeholder businesses. A private installation points `config.goals` at its own file, which never enters the public repository.

```json
{
  "goals_version": "1",
  "businesses": [
    {
      "id": "biz-a",
      "name": "Example SaaS",
      "owner": "founder",
      "objective": "Reach 100 paying customers by end of quarter",
      "metrics": [
        { "name": "paying_customers", "target": 100, "current": 42, "unit": "count", "source": "manual", "updated_at": "2026-09-01T00:00:00Z" },
        { "name": "first_pass_rate", "target": 0.7, "current": null, "unit": "ratio", "source": "ledger:report.first_pass_rate", "task_class": "feature" }
      ],
      "constraints": ["no autonomous merge", "spend under 20 USD per week on agents"],
      "task_classes": ["feature", "bugfix", "growth-experiment"]
    }
  ]
}
```

`source` values: `manual` (a human updates `current`), `ledger:<report field>` (the kit fills `current` from `report` at read time). `cortexctl goals:show [--business <id>]` prints the contract with ledger sourced metrics filled and a `gap` per metric (target minus current, signed). `cortexctl goals:set --business <id> --metric <name> --current <value>` updates a manual metric and records who did it in `human_interventions` kind `note`.

## Proposals

Table `proposals`: `id` (`p_`), `created_at`, `author` (agent or human id), `business_id`, `goal_metric` (nullable), `kind` (`task`, `policy`, `tooling`, `experiment`), `title`, `rationale`, `expected_impact` (free text tied to a metric), `estimated_usd` (REAL), `estimated_hours` (REAL), `task_class`, `status` (`proposed`, `under_review`, `approved`, `rejected`, `converted`, `expired`), `converted_task_id`, `decided_by`, `decided_at`, `decision_note`.

Table `proposal_reviews`: `id` (`pr_`), `proposal_id`, `created_at`, `reviewer` (agent id), `verdict` (`support`, `oppose`, `revise`), `note`, `confidence` (REAL).

Commands: `propose --author <a> --business <id> --kind <k> --title <t> --rationale <file|text> --impact <text> [--metric <name>] [--usd <x>] [--hours <h>] [--class <c>]` prints the id. `proposal:review --id <p> --reviewer <a> --verdict support|oppose|revise [--note ...] [--confidence <x>]`. `proposal:list [--status s] [--business id]`. `proposal:approve --id <p> --by <human> [--note ...]` converts to a task through the same code path as `task:new` (kind from proposal kind, arm from `config.autonomy.default_arm`, owner from `config.autonomy.default_owner`), sets `converted_task_id`, status `converted`. `proposal:reject --id <p> --by <human> --note ...`. Proposals older than `config.autonomy.proposal_ttl_days` with status `proposed` move to `expired` on the next loop tick.

Rules: an agent may not review its own proposal. A proposal needs at least `config.autonomy.min_reviews` reviews (default 1) before it is eligible for approval. Approval is human unless the autonomy dial allows otherwise (below).

## Lessons

Table `lessons`: `id` (`l_`), `created_at`, `source` (`adjudication`, `escalation`, `retro`, `agent`, `human`), `task_id` (nullable), `business_id` (nullable), `task_class` (nullable, null means all), `applies_to` (`builder`, `reviewer`, `architect`, `all`), `lesson` (one or two sentences, imperative), `evidence` (ids and counts, no prose), `confidence` (REAL), `status` (`active`, `retired`), `retired_reason`.

Commands: `lesson:add --source <s> --lesson <text> [--task <id>] [--class <c>] [--applies-to <a>] [--evidence <text>] [--confidence <x>]`, `lesson:list [--class c] [--applies-to a] [--status s]`, `lesson:retire --id <l> --reason ...`.

Injection: `packet` includes `lessons[]`, the top `config.autonomy.lessons_per_packet` (default 5) active lessons where `task_class` matches or is null and `applies_to` matches the packet's next actor or is `all`, ordered by confidence then recency. `review:brief` includes reviewer lessons the same way. This is the only path by which a lesson changes behaviour; nothing rewrites a prompt file automatically.

Auto drafting: `adjudicate` with `--lesson <text>` writes a lesson with source `adjudication` in the same call. `retro` drafts lessons from patterns (below). A drafted lesson starts with confidence 0.5; a human raising it above 0.8 is the signal that it is trusted.

## Retro

`cortexctl retro [--since <iso>] [--business <id>] [--out <dir>]` reads the ledger and writes `retro.md` plus `retro.json`, and inserts drafted lessons and proposals with `status = proposed` and `author = retro`. It never changes config, prompts, or routing.

Patterns it looks for, each with the threshold that triggers a draft:

| Pattern | Threshold | Draft |
|---|---|---|
| A guard fired on the same task class repeatedly | 3 or more firings in the window | Lesson for the actor that could have prevented it (for example `files_touched` on class `ui` → architect lesson: list the files in the brief) |
| Reviewer precision for a provider on a class is low | at least 10 adjudicated verdicts and precision under 0.4 | Policy proposal: drop or swap that reviewer for the class |
| Control arm matches tri arm on escaped defects at lower cost | at least 20 adjudicated pairs, escaped defects equal, cost ratio under 0.6 | Policy proposal: route the class to a single agent |
| Tri arm catches defects the control arm ships | at least 20 adjudicated pairs, tri escaped defects lower | Policy proposal: keep tri for the class, note the cost multiple |
| A metric in the goals contract has a gap and no open task or proposal targets it | any | Task proposal per metric, `kind = task`, with rationale citing the gap |
| The same tool failure repeats across runs | 3 or more `tool_failure` escalations naming the same tool | Tooling proposal: fix or replace the tool, with the failure count |
| A quota window hit its limit | any | Tooling proposal: add capacity or reroute, with the provider and window |

The 20 run threshold for routing proposals is the same rule as `report`: nothing about routing is even proposed on thin data, and nothing is applied without `policy:apply`.

## Policy proposals

`policy:apply --id <p> --by <human>` is the only command that changes routing, and it changes it by writing `config.agents` overrides for a task class into a `policy` table (`id` `po_`, `applied_at`, `proposal_id`, `task_class`, `agent_overrides_json`, `applied_by`, `active`). `run:start` consults the active policy for the task's class before falling back to `config.agents`. `policy:revert --id <po>` deactivates it. A policy proposal cannot be applied unless its supporting run count is at least 20 at apply time, re computed, not copied from the proposal.

## The loop

`cortexctl loop --agent <name> [--once] [--max-tasks <n>] [--max-usd <x>] [--business <id>]` is the body a CortextOS heartbeat or a cron calls. One tick:

1. Refuse with exit 6 if `config.autonomy.enabled` is false. Turning it on is a deliberate act by the operator and is recorded in `human_interventions` kind `note` on first use.
2. Expire stale proposals.
3. Build the board packet for this agent. If a task assigned to this agent has `next_action.actor` equal to this agent, execute that one action through the existing commands (`run:launch` for a builder, `review:brief` plus `run:launch` for a reviewer, `ingest` and `run:end` for a run whose `done.marker` appeared) and stop. One action per tick keeps the heartbeat bounded and lets the watchdog and limits do their job between ticks.
4. If nothing is assigned, and `config.autonomy.propose` is true, and this agent has authored fewer than `config.autonomy.max_open_proposals_per_agent` open proposals: read `goals:show` for the agent's business, the open proposals, the last `retro.json` if present, and the active lessons; ask the agent's adapter for exactly one proposal in the proposal JSON shape (the prompt is `prompts/proposer.md`); validate; insert it. Cost of that call is recorded in `cost_usage` against a synthetic task per business named `_proposals` so proposal spend is visible and capped by `--max-usd`.
5. If there are open proposals by other agents that this agent has not reviewed, and `config.autonomy.review_proposals` is true, review one (prompt `prompts/proposal-reviewer.md`), insert the review, stop.
6. Write a `loop_ticks` row (`id` `lt_`, `agent`, `started_at`, `ended_at`, `action`, `task_id`, `proposal_id`, `cost_usd`, `note`) so `doctor --all` can say what every agent did on its last tick and `report --loop` can show autonomous activity per agent.

Without `--once` the loop repeats every `config.autonomy.interval_s` (default 900) until `--max-tasks` or `--max-usd` is reached, then exits 0. A CortextOS heartbeat should always pass `--once`; the harness owns the schedule.

## The autonomy dial

```json
"autonomy": {
  "enabled": false,
  "propose": true,
  "review_proposals": true,
  "auto_approve_below_usd": 0,
  "auto_approve_kinds": ["task"],
  "min_reviews": 1,
  "max_open_proposals_per_agent": 3,
  "proposal_ttl_days": 14,
  "lessons_per_packet": 5,
  "default_arm": "tri",
  "default_owner": "founder",
  "interval_s": 900
}
```

`auto_approve_below_usd` is the dial. At 0 every proposal waits for a human. At 2, a task proposal estimated under 2 USD with at least `min_reviews` supporting reviews and no opposing review is approved by the loop itself, converted to a task, and picked up on a later tick, so agents build small things end to end without anyone prompting them. Policy and tooling proposals are never auto approved regardless of the dial. Autonomous merges do not exist at any dial setting; a built task ends as a reviewed patch on a branch, and a human merges.

## Safety properties

Every autonomous action is one of the existing commands, so every hard limit, guard, quota check, and escalation applies unchanged. Spend on proposing and reviewing proposals is recorded and capped. Nothing rewrites prompts, config, or routing without a human command. Lessons influence behaviour only through packets and briefs, where they are visible. The loop does one action per tick. Turning autonomy on is explicit and logged.

## Mapping to CortextOS

The agent templates in `community/` get a heartbeat line: `cortexctl loop --agent <me> --once`. CortextOS's inbox carries the packet's `next_action` line when the actor is human. The goals file can live at `orgs/<org>/cortex-goals.json` beside the ledger. Nothing in CortextOS changes; the ledger and the loop are what its heartbeat calls.
