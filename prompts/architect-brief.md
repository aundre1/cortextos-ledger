# Architect brief template

This is the template for `<runs>/<task-id>/brief.md`, the one document every
agent on a task actually reads before it starts work. Fill in every section
before `run:start`. An agent that receives a brief with a blank section should
treat that as missing information, not as permission to guess.

Both arms of a measured task (control and tri) get the same brief, generated
once from the same issue, so the comparison in `cortexctl compare` is fair.

---

## Issue

Task: `<task id, from task:new>`
Repo: `<owner/name or local path label>`
Issue or PR: `<issue number, or "none" for a research/ops task>`
Base commit: `<sha>`
Branch: `<branch name>`

Paste the issue title and full body here, unedited. If the issue is vague,
say so below rather than filling in gaps here; the builder is instructed to
implement the issue as written, so an editorialized version of it here would
quietly change what gets built.

## Acceptance criteria

List the concrete, checkable conditions that make this task done. Each one
should be something a reviewer or a test can verify without asking the
architect what was meant.

- [ ] `<criterion 1>`
- [ ] `<criterion 2>`

## Likely files

Files or directories the architect expects this issue to touch, from reading
the codebase, not a guess. This is a hint for the builder, not a ceiling; the
file cap below is the ceiling.

- `<path>`

## Test commands

The exact command(s) that must pass before this task is considered done, in
the form the builder should run them.

```
<e.g. node --test test/>
```

## Limits

Copied from `cortexctl limits` at the time this brief was written, so the
brief is self-contained even if the config changes later:

- Builder attempts: `<builder_attempts_max>`
- Challenge cycles: `<challenge_cycles_max>`
- Wall clock per run: `<wallclock_s>` seconds
- Spend per task: `<spend_usd>` USD
- Files touched per run: `<files_touched_max>`

## What "done" means

One paragraph. Not "tests pass": say what a human glancing at the patch and
the test output should be able to confirm without re-reading the issue. If
there is a condition under which this task is done by explicitly not
implementing something (a deliberately deferred edge case, a follow up issue
instead), say that here, in advance, so it is not a surprise finding for the
reviewer.
