# Community packaging for upstream CortextOS

Upstream (`grandamenium/cortextos`, MIT) accepts contributions into a community catalog. This kit ships the artifacts in that format so a CortextOS user installs the ledger as a skill and two agent templates, and a maintainer can register them with one catalog entry.

## Upstream conventions to match exactly

The executor building `community/` must fetch the current upstream `CONTRIBUTING.md`, `community/catalog.json`, and existing skill and agent template examples from the upstream repository and match their frontmatter, file names, folder layout, and JSON key order exactly. Byte-verified against `raw.githubusercontent.com/grandamenium/cortextos/main/...` on 2026-09-07 (`community/skills/tasks/SKILL.md`, `community/skills/heartbeat/SKILL.md`, `community/agents/analyst/{config.json,IDENTITY,SOUL,GUARDRAILS,HEARTBEAT}.md`, `community/agents/research-agent/config.json`, `CONTRIBUTING.md`, `community/catalog.json`):

- Skills live at `community/skills/<name>/SKILL.md` with frontmatter fields, in this order: `name`, `description`, `triggers`, `external_calls`. `external_calls` lists external APIs/services/URLs the skill contacts over the network — **not** the skill's own project's local CLI. Upstream's own `tasks` and `heartbeat` skills call `cortextos bus ...` (their local CLI) throughout and still ship `external_calls: []`; a skill whose only calls are to its own project's CLI (`cortexctl`, `git`) should do the same.
- Agent templates require `IDENTITY.md`, `SOUL.md`, `GUARDRAILS.md`, and `config.json` (`GOALS.md`, `HEARTBEAT.md`, `TOOLS.md` are recommended, not required). `config.json` is a CortextOS daemon lifecycle config: `agent_name`, `enabled`, an optional `runtime` (seen as `"claude-code"` on `research-agent`; absent entirely on `analyst`; `"opencode"` and `"codex-app-server"` are this kit's own values, unverified against any fetched upstream example), `startup_delay`, `max_session_seconds`, `max_crashes_per_day`, `working_directory`, `timezone`, `approval_rules: {always_ask, never_ask}`, `crons[]` (each `{name, type, interval|cron, prompt}`), and an `ecosystem` block of CortextOS-native integration toggles this kit's agents don't participate in. `CONTRIBUTING.md`'s own inline description of `config.json` ("model, crons, startup config") does not match either fetched example's actual keys (neither has a `model` field) — flagging the mismatch rather than resolving it, since it isn't ours to fix.
- Registration is an entry in `community/catalog.json`, an object `{version, updated_at, items: [...]}`. Each item uses exactly these keys, in this order: `name`, `description`, `author`, `type`, `version`, `tags`, `review_status`, `dependencies`, `install_path`, `submitted_at`. There is no `source`/repository-link field anywhere in the 30 fetched items; a contributor's repository link does not belong in the catalog entry.
- PR title format: `feat: add <name> [skill|agent|org] to community catalog`; branch `feat/skill-<name>` or `feat/agent-<name>`.
- Write for agent execution, not for human readers.

Full comparison table, and what this kit kept versus aligned, is in `community/UPSTREAM-DIFF.md`. If any of these has changed upstream since this pass, the fetched version wins and this document is updated in the same pull request.

## Artifacts

### Skill `cortex-ledger`

`community/skills/cortex-ledger/SKILL.md`. Triggers on: opening a task, starting work on an issue or PR, reporting completion, asking what to do next, asking why an agent stalled. Body is an operating procedure an agent follows verbatim: `cortexctl packet --board --owner <me>` first; `cortexctl run:start` before touching files; `cortexctl run:end`, `artifact`, `test` when done; `BLOCKED:` and `SCOPE_EXCEEDED` conventions; never close a task yourself, the owner closes. `external_calls: []` — `cortexctl` and `git` are this kit's own local CLI and version control, not an external network call, matching upstream's own convention (see above).

### Agent template `blind-reviewer`

`community/agents/blind-reviewer/`. `IDENTITY.md`: a reviewer that receives a diff and an issue and nothing else. `SOUL.md`: careful, specific, evidence first, no praise, no speculation about intent. `GUARDRAILS.md`: read only; never open paths under `builder/`; never edit tests; refuse to review without a base commit and a diff; output must validate as `verdict.json`. `config.json`: `runtime: "opencode"` with a read only permission block, model left as a placeholder the operator sets, and a note that the reviewer's provider must differ from the builder's.

### Agent template `novice-builder`

`community/agents/novice-builder/`. `IDENTITY.md`: a careful junior engineer who double checks and reports. `SOUL.md`: novice framing, verification before claims, one issue at a time. `GUARDRAILS.md`: never edit a failing test to make it pass; a broken tool is a report; stop at the file cap with `SCOPE_EXCEEDED`; write `reasoning.md` and `patch.diff` before declaring done; no push, no merge. `config.json`: `runtime: "opencode"` (with a documented alternative `codex-app-server`), edit and bash allowed with the denied git commands listed.

### Catalog entry

`community/catalog.entry.json` holds the three entries ready to append to upstream `community/catalog.json`, each with `review_status: "pending"` and no field beyond upstream's own item shape (`name`, `description`, `author`, `type`, `version`, `tags`, `review_status`, `dependencies`, `install_path`, `submitted_at`). The repository link lives in `community/README.md` instead, since upstream's catalog item schema has no field for it.

## Heartbeat integration

The upstream agent template convention includes a `HEARTBEAT.md`. The two agent templates here include a heartbeat section: on each heartbeat, run `cortexctl packet --board --owner <agent>` and act only on tasks assigned to this agent; if the packet says `next_action.actor` is `human`, post the packet's next action line to the inbox and stop.

## The upstream pull request

Opened only after the kit's v0.1 review passes and the owner approves. Contents: the three catalog entries and a short README pointer. No code from `src/` goes into the upstream PR; the kit stays a separate repository so it can move faster than a 160 PR queue. The PR description states the failure modes addressed in general terms and links the public measurement export, not the private findings.
