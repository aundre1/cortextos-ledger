# Example: turning on the autonomy dial

This walks the dial from fully off to a small, bounded amount of autonomous
building, and shows what a day of `loop` ticks looks like in the ledger.
Commands are `cortexctl` flags from `docs/autonomy.md` and `docs/cli.md`;
nothing here is invented. Assumes `cortexctl init` has already run and
`config.goals` points at a real goals file (copy
`examples/cortex-goals.example.json` and edit it - it never enters a public
repository).

## 1. Everything starts off

```json
"autonomy": { "enabled": false }
```

With `enabled: false`, `cortexctl loop --agent architect --once` refuses with
exit 6 and writes no rows at all. This is the default the kit ships with.
Turning it on is a deliberate, one-line edit to `cortex-ledger.json`:

```json
"autonomy": { "enabled": true, "propose": true, "review_proposals": true }
```

The first tick after that edit records a `human_interventions` row (kind
`note`) against a synthetic `_loop` task, so "autonomy was switched on" is
itself a ledger fact, not a silent config change.

## 2. A day of ticks with the dial still at 0

At `auto_approve_below_usd: 0` (the shipped default), nothing converts to a
task without a human. A CortextOS heartbeat line for each agent:

```bash
cortexctl loop --agent architect --once --business biz-a
cortexctl loop --agent builder   --once --business biz-a
```

One heartbeat, one bounded action, per the doc's six-step tick:

1. `architect` has nothing assigned, reads `goals:show`, drafts one proposal
   from the largest gap (`propose --once` equivalent to `cortexctl propose`,
   but authored by the model, not a human) - `proposal:list` now shows one
   row, status `proposed`.
2. `builder` has nothing assigned either, but there is an open proposal by
   another agent it has not reviewed - it reviews `support` or `oppose`. The
   proposal moves to `under_review`.
3. `cortexctl report --loop` shows one tick each, the actions histogram
   (`proposed=1`, `reviewed=1`), and total proposal spend across every
   `_proposals` synthetic task.

Nothing is built yet. A human runs:

```bash
cortexctl proposal:list --status under_review
cortexctl proposal:approve --id p_... --by aundre
```

## 3. Turning the dial up a little

```json
"autonomy": { "auto_approve_below_usd": 5, "min_reviews": 1 }
```

Now a `task` proposal estimated under $5, with at least one supporting review
and no opposing one, is approved by the loop itself on its very next tick -
no human in that path. The next `loop --once` for the authoring agent
converts it to a real task (`proposal_reviews` shows the support, `proposals`
shows `status = converted` and `converted_task_id`), and a *later* tick for
whichever agent owns that task's class picks it up: `run:launch` for the
builder, `review:brief` plus `run:launch` for the reviewer (tri arm), then
`run:end`/`ingest` once its `done.marker` appears. Every one of those is the
same command a human would have typed; the loop only decided when to type it.

The result still ends as a reviewed patch on a branch. Autonomous merges do
not exist at any dial setting - a human runs `task:close` and merges by hand.

## 4. What a day looks like end to end

```bash
cortexctl loop --agent architect --once --business biz-a   # proposes
cortexctl loop --agent builder   --once --business biz-a   # reviews it, support
cortexctl loop --agent architect --once --business biz-a   # auto approves, converts
cortexctl loop --agent builder   --once --business biz-a   # picks up the new task, launches the builder
# ... run:end / ingest happen on a later tick once done.marker appears ...
cortexctl packet --task <converted task id>                # shows the lessons[] section and the task
cortexctl retro --business biz-a                            # drafts a lesson and/or a proposal from the day's patterns
cortexctl report --loop                                     # ticks, actions histogram, proposal spend
```

## A heartbeat line for `community/` agent templates

```
cortexctl loop --agent <me> --once
```

A CortextOS heartbeat should always pass `--once`; the harness owns the
schedule (`config.autonomy.interval_s`), not the loop command itself.
