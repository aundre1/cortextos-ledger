# Contributing

The spec lives in `docs/*.md`, not in this file and not in anyone's head. If
you are about to add a command, a table, a column, an exit code, or a file
name that `docs/` does not already describe, update the doc in the same pull
request and say so in the description. Code that invents behavior the docs
are silent on, without saying so, is the thing this rule exists to prevent.

## Before you open a pull request

- One issue per pull request. A pull request that fixes one thing and quietly
  refactors something unrelated is two pull requests wearing one diff.
- Tests are required for anything under `src/`, `bin/`, `scripts/`, or
  `plugins/`. `node --test "test/**/*.test.mjs"` must pass.
- `node scripts/publish-check.mjs` must pass. It refuses anything under
  `.cortex/` or `orgs/`, anything named `events.jsonl` or `reasoning.md`, any
  secret file name, and any tracked file whose content matches a secrets
  pattern or a personal path. Run it before you push, not after CI catches it.
- Windows and Linux both green. CI runs `windows-latest` and `ubuntu-latest`;
  a pull request that only works on one of them is not done. Use
  `path.join`, never a hardcoded `/tmp` literal, no `chmod`, no shell pipes in
  anything `test/` depends on.
- No quotes or names from any community call, anywhere, including code
  comments and commit messages. `docs/security.md` explains why; the rule has
  no exceptions for a quote that seems harmless.

## Adding an adapter

An adapter is one file under `src/adapters/` exporting `run(opts)` per the
interface in `docs/adapters.md`. It:

- Applies the credential boundary (`src/adapters/credential-boundary.mjs`)
  before spawning anything; it does not invent its own environment filtering.
- Writes `events.jsonl` in the normalized event format, not the harness's
  native stream format; `ingest` only ever reads the normalized format.
- Never reads the ledger and never decides a retry. Those are the caller's
  job, not the adapter's.
- Has a fixture-driven test under `test/fixtures/` exercising its stream
  parser against a realistic sample of that harness's actual output, not a
  hand-simplified one.

Register it in `src/adapters/index.mjs`'s allowlist. Do not import a new
adapter file from anywhere else in `src/`; the registry is the only caller.

## Adding a guard

A guard is a pure function that takes plain data (not a live process, not a
db handle mid-transaction) and returns a decision: pass, or an escalation
reason and severity. Before adding one:

- Name the failure it prevents, in one sentence, the way `docs/guards.md`
  does for every existing guard. A guard without a named failure is a guess.
- Decide preflight, runtime, or post run, and put it in the matching file
  under `src/guards/`.
- Give it a test that proves it fires under the exact condition it claims to
  catch, using the `fake` adapter and a temp git repo from `test/helpers.mjs`,
  not a real harness.
- Update `docs/guards.md`'s table in the same pull request. An enforced guard
  that is not documented is invisible to the next person who needs to know
  it exists.

## Where a doc is silent

Pick the most conservative option, implement it, and say so: append an
`OPEN QUESTION:` line to that wave's log rather than guessing quietly. A
maintainer arbitrates it later. This is not a formality; it is how the ledger
stays a single source of truth instead of drifting doc from code one silent
judgment call at a time.
