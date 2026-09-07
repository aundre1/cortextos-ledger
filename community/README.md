# Installing cortex-ledger into a CortextOS org

These three artifacts (one skill, two agent templates) let an existing
CortextOS installation use `cortextos-ledger` without any of this kit's own
source code entering the upstream catalog. Register `community/catalog.entry.json`
in upstream `community/catalog.json` and copy the directories below into the
org's own tree; nothing else is required.

Source repository: https://github.com/aundre1/cortextos-ledger. Upstream's
`community/catalog.json` item schema has no field for this link (see
`community/UPSTREAM-DIFF.md`), so it lives here instead of in the catalog
entry itself.

## Layout

```
orgs/<org>/
  .cortex/
    ledger.db        the ledger for this org, created by `cortexctl init`
    runs/             run directories, never committed (see docs/security.md)
  .claude/skills/cortex-ledger/SKILL.md      (or the harness's equivalent skills path)
  agents/blind-reviewer/{IDENTITY,SOUL,GUARDRAILS}.md, config.json, HEARTBEAT.md
  agents/novice-builder/{IDENTITY,SOUL,GUARDRAILS}.md, config.json, HEARTBEAT.md
```

`orgs/` is already inside CortextOS's own `.gitignore`, and `cortextos-ledger`'s
`.gitignore` and `scripts/publish-check.mjs` both refuse to let anything under
it, or the ledger database, or a run directory, be committed or packaged.

## Steps

1. Copy `community/skills/cortex-ledger/SKILL.md` into the org's skills path.
2. Copy `community/agents/blind-reviewer/` and `community/agents/novice-builder/`
   into the org's agents path, each as its own directory.
3. In each `config.json`, set the `model` field. Both are shipped with it
   blank on purpose: the kit ships no default models, per
   `docs/adapters.md`. **The reviewer's provider must be a different lab from
   the builder's provider.** Pointing both at the same lab defeats the entire
   point of blind review; nothing in the code stops you from doing it wrong,
   the ledger just records a review that was never actually independent.
4. Run `cortexctl init --db orgs/<org>/.cortex/ledger.db` once to create the
   database.
5. Point each agent's runtime at `cortexctl` for the task lifecycle: `packet`
   on heartbeat, `run:start` before work, `run:end`/`artifact`/`test` after.
   The skill file spells out the exact commands; the agent templates'
   `HEARTBEAT.md` files spell out when to run them.

## What review_status: pending means

Every entry in `catalog.entry.json` ships with `review_status: "pending"`,
matching upstream `community/catalog.json`'s own item shape exactly (see
`community/UPSTREAM-DIFF.md` for the byte-level comparison). A maintainer
flips it to `"approved"` after reviewing it against upstream's own checklist
in `CONTRIBUTING.md`; nothing here self-approves.
