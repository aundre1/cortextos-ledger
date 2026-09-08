# Example: measuring PR triage with OpenCode Go as the builder lane

This is the recipe for the 20-task PR-triage measurement run using
`examples/config.opencode-go.json`: builder and solo on an OpenCode Go
subscription, `reviewer` and `reviewer_b` on two other labs so the review
stays independent (`docs/review-protocol.md` "Roles"). It extends
`examples/pr-triage.md` (read that first for what each command does) with
the control arm and the OpenCode Go quota setup this config needs.

Every command below exists in `bin/cortexctl.mjs`; nothing here is invented.
`--config examples/config.opencode-go.json` is shown explicitly throughout --
in practice, copy the file to `cortex-ledger.json` in the repo root (with
real model strings filled in, see below) and drop the flag, or point
`CORTEX_LEDGER_CONFIG` at it.

## 0. Fill in the placeholders, once

`examples/config.opencode-go.json` ships with every `model` field blank plus
a `_model_note` explaining what belongs there (the same convention
`community/agents/blind-reviewer/config.json` uses). Before the first run,
set:

- `agents.builder.model` and `agents.solo.model` to the exact same OpenCode
  Go model string -- solo is the control arm's build agent standing in for
  "no reviewer", not a different model (`docs/measurement.md`).
- `agents.reviewer.model` to a Google model reached through the operator's
  own OpenCode configuration.
- `agents.reviewer_b.model` to an OpenAI model, for the Codex adapter.

`agents.builder.model`/`agents.solo.model` must not contain `anthropic` or
`claude` -- `src/adapters/opencode.mjs` refuses those with exit 1.

## 1. Create the ledger, once

Copy the example into the directory that will hold the ledger first. `db` and
`runs` in the config are resolved relative to the config file, so running
`init` against the file inside `examples/` would create `examples/.cortex/`
inside the kit's own tree instead of in your project.

```bash
cp examples/config.opencode-go.json ./cortex-ledger.json
cortexctl init --config ./cortex-ledger.json
```

Every later command in this recipe uses `--config ./cortex-ledger.json`;
the `examples/...` path is shown only to name the file the settings came from.

`examples/config.opencode-go.json`'s `providers.opencode-go.windows` block
(5h/week/month, matching the OpenCode Go subscription's own ceilings) is
enforced by `run:start`'s quota gate and by `ingest` directly from the
config file -- no `quota:set` call is required for these three windows to
be real limits. Check headroom at any point, across all 20 tasks, with:

```bash
cortexctl quota:show --config examples/config.opencode-go.json
```

`quota:show`'s `origin` column reads `config` for these three windows,
confirming the ceiling in effect came from the config file rather than a
manual override.

`quota:set` is still there as an optional override for this run only --
useful to tighten a window below the config's own number (an
already-partway-through-the-billing-period subscription, say) without
editing the shared config file:

```bash
cortexctl quota:set --config examples/config.opencode-go.json \
  --provider opencode-go --window 5h --limit-usd 8
```

A window set this way shows `origin quota:set` in `quota:show` and is never
overwritten by the config file again, even if the config's own number for
that window later changes.

## 2. Per PR: open the control task, one reviewer, no builder

PR triage never runs a builder (`docs/review-protocol.md` "PR triage mode");
the control arm here isolates one variable -- a single independent reviewer
-- against the tri arm's two. Repeat this section and the next once per
measured PR (20 times for the full run).

```bash
control_task=$(cortexctl task:new --config examples/config.opencode-go.json \
  --repo owner/name --title "Triage PR #742" --class pr-triage \
  --arm control --kind pr_review --pr 742)

cortexctl review:brief --config examples/config.opencode-go.json \
  --task "$control_task" --reviewer reviewer
control_run=$(cortexctl run:launch --config examples/config.opencode-go.json \
  --task "$control_task" --agent reviewer --prompt-file ./reviewer/brief.md)
cortexctl watch --config examples/config.opencode-go.json --run "$control_run"

cortexctl verdict --config examples/config.opencode-go.json \
  --task "$control_task" --run "$control_run" --reviewer reviewer \
  --provider google --model "$reviewer_model" \
  --file ./reviewer/verdict.json
```

`$reviewer_model` is the value filled into `agents.reviewer.model` in step 0
above -- `verdict` records the model that actually ran, so pass the real
string here, not the config file's placeholder.

## 3. Open the tri task, linked to the control task, two reviewers

```bash
tri_task=$(cortexctl task:new --config examples/config.opencode-go.json \
  --repo owner/name --title "Triage PR #742" --class pr-triage \
  --arm tri --kind pr_review --pr 742 --sibling "$control_task")

cortexctl review:brief --config examples/config.opencode-go.json \
  --task "$tri_task" --reviewer reviewer
run_a=$(cortexctl run:launch --config examples/config.opencode-go.json \
  --task "$tri_task" --agent reviewer --prompt-file ./reviewer/brief.md)
cortexctl watch --config examples/config.opencode-go.json --run "$run_a"
cortexctl verdict --config examples/config.opencode-go.json \
  --task "$tri_task" --run "$run_a" --reviewer reviewer \
  --provider google --model "$reviewer_model" \
  --file ./reviewer/verdict.json

cortexctl review:brief --config examples/config.opencode-go.json \
  --task "$tri_task" --reviewer reviewer_b
run_b=$(cortexctl run:launch --config examples/config.opencode-go.json \
  --task "$tri_task" --agent reviewer_b --prompt-file ./reviewer_b/brief.md)
cortexctl watch --config examples/config.opencode-go.json --run "$run_b"
cortexctl verdict --config examples/config.opencode-go.json \
  --task "$tri_task" --run "$run_b" --reviewer reviewer_b \
  --provider openai --model "$reviewer_b_model" \
  --file ./reviewer_b/verdict.json
```

`$reviewer_model`/`$reviewer_b_model` are the values filled into
`agents.reviewer.model`/`agents.reviewer_b.model` in step 0.

`reviewer` and `reviewer_b` must be different labs; this config wires them
to `google` and `openai` so that picking the same provider for both, which
would defeat the point, cannot happen by accident.

## 4. A human adjudicates both tasks

```bash
cortexctl adjudicate --config examples/config.opencode-go.json \
  --task "$control_task" --real 1 --noise 0 --minutes 5 \
  --note "single reviewer found the real off-by-one"
cortexctl adjudicate --config examples/config.opencode-go.json \
  --task "$tri_task" --real 2 --noise 1 --minutes 10 \
  --note "reviewer found the same off-by-one, reviewer_b also flagged a missing test; one style nit was noise"
```

## 5. Triage note and close

```bash
cortexctl triage:note --config examples/config.opencode-go.json --task "$tri_task"

cortexctl task:close --config examples/config.opencode-go.json \
  --task "$control_task" --outcome first_pass
cortexctl task:close --config examples/config.opencode-go.json \
  --task "$tri_task" --outcome first_pass
```

## 6. Compare, after all 20 pairs are adjudicated and closed

```bash
cortexctl compare --config examples/config.opencode-go.json --pr 742
cortexctl report --config examples/config.opencode-go.json --class pr-triage --reviewers
```

`report` prints `n < 20, not routing grade` beside any class with fewer than
20 adjudicated runs -- with exactly 20 measured pairs this is the first
report worth reading past that caveat. Remember while reading it that
`google` and `openai` costs are billed per token against the operator's own
accounts while OpenCode Go's are a USD-equivalent share of a flat monthly
subscription (`docs/measurement.md` "OpenCode Go as the builder lane") --
compare cost multiples within a lane, not across them.

`cortexctl export --config examples/config.opencode-go.json --format csv --out ./export --since <date>`
produces the public datapoints once every pair is adjudicated
(`docs/measurement.md` "Public datapoints").
