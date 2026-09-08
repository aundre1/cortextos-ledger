# Review protocol

Cross model adversarial review is the community's consensus fix for agents marking their own homework. Nobody records whether the reviewer was right. This protocol records it.

## Roles

| Role | Sees | Writes | Provider rule |
|---|---|---|---|
| Builder | Issue, brief, worktree | Code, `patch.diff`, `reasoning.md` | Any |
| Reviewer | Issue, base commit, `patch.diff`, touched test list | `verdict.json` | Different lab from the builder; read only tools |
| Reviewer B (PR triage only) | Same as reviewer | `verdict.json` | Different lab from reviewer and builder |
| Architect | Packet, verdict summary, compare | Brief, challenge message, adjudication | Never raw logs |
| Human | Everything | Adjudication, interventions | |

## Blindness

The reviewer must not see `reasoning.md`, the builder's `out.txt`, the architect's rationale, or its own earlier verdict. Enforced three ways:

1. Filesystem: the reviewer's run dir and allowed directories exclude `builder/`. `review:brief` copies `patch.diff` into `reviewer/` and references only that path.
2. Harness permissions: reviewer agents are `read_only: true` in the adapter config; the OpenCode agent definition denies `edit`, `write`, `bash` except a fixed allowlist (`git diff`, `git show`, test commands from config) plus the one narrow carve-out below that lets the reviewer write its own required output file and nothing else.
3. Ledger: the first verdict is stored with `blind = 1` and `challenge_seq = 0`. If the reviewer's `events.jsonl` shows a read of any path under `builder/` or any file named `reasoning.md`, `verdict` stores `blind = 0` and writes escalation `verdict_invalid` severity `warn`. The verdict is kept, flagged, and excluded from blind statistics.

### Writing `verdict.json` under a read-only harness

The prompts (`prompts/reviewer.md`, `prompts/pr-triage-reviewer.md`) tell the reviewer to write `verdict.json` into the run directory. A reviewer's OpenCode agent definition is `read_only: true`, which `src/adapters/opencode.mjs`'s `buildOpencodeAgentDefinition` enforces by refusing to launch (exit 1) unless the resolved permission actually denies `edit` by default — so the two requirements only coexist if `edit` itself can deny everything except this one file.

It can. OpenCode 1.18.27's own permission schema (`packages/core/src/v1/config/permission.ts`, `sst/opencode` tag `v1.18.27`, fetched from `raw.githubusercontent.com`) types `edit` as a `Rule = Action | Record<string, Action>` — the exact same shape `bash` already uses in `community/agents/blind-reviewer/config.json` (`{"*": "deny", "git diff*": "allow", ...}`), not a bare `Action`. So a per-path glob-to-action object is a first-class value for `edit`, not an extension of the schema. `packages/opencode/src/permission/index.ts`'s `Permission.evaluate` resolves it with `rulesets.flat().findLast(rule => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))` — the **last** matching rule in the object's own key order wins, over an earlier match included. `packages/opencode/src/util/wildcard.ts`'s `match` turns `*` into `.*` (dotall, so it matches `/` too) and normalizes `\` to `/` before comparing, so a glob like `**/verdict.json` matches `verdict.json` at any depth on either OS. `packages/opencode/src/tool/edit.ts` and `write.ts` both call `ctx.ask({ permission: "edit", patterns: [path.relative(instance.worktree, filePath)], ... })` — the pattern evaluated is the file path *relative to OpenCode's own worktree* (the run's `cwd`), so the config's glob does not need to be an absolute path, and matches regardless of how deep the run directory sits under that worktree.

Chosen fix (no prompt changes needed, "keep the prompts as they are" holds): `community/agents/blind-reviewer/config.json`'s `permission.edit` is now `{"*": "deny", "**/verdict.json": "allow"}` — deny-by-default, listed first, with the one override listed after it so `findLast` picks the override for that one path and the wildcard for everything else. `src/adapters/opencode.mjs`'s `permissionDeniesEdit` (the function `buildOpencodeAgentDefinition`'s `read_only` gate calls) was updated to recognize this shape: an object `edit` value counts as "denies edit" when its own `"*"` entry is `"deny"`, regardless of a narrower allow entry elsewhere in the same object — mirroring the semantics `Permission.evaluate` actually implements, so this check does not falsely refuse to launch, and does not falsely pass a template that is mostly-allow with one narrow deny (verified in `test/adapters.test.mjs`). The `write`/`apply_patch` tools funnel through the same `permission: "edit"` check, so this one change covers whichever tool the reviewer's harness picks to create the file.

This was verified against OpenCode's real source, not merely inferred from the prose in `docs/adapters.md`'s existing D1/D2 sections; a live run on the target Windows machine (`docs/adapters.md` "opencode: edit permission is per-path, not per-tool (V1)") is still the proof that OpenCode 1.18.27 enforces it exactly this way at runtime, since `OPENCODE_CONFIG_CONTENT` is merged (`mergeDeep`, last) over whatever the operator's own real `opencode.json`/`opencode.jsonc` already defines for an agent of the same name, which this kit cannot see from the isolated launch alone.

## Reviewer brief (`cortexctl review:brief --task <id> --reviewer reviewer`)

Generated from the ledger, written to `<runs>/<task>/reviewer/brief.md`. Contents in order: the issue title and body (from `agent_messages` kind `brief` or `--issue-file`), base commit, branch, the list of touched test files if any (with the instruction to verify each edit is justified by the issue), the diff inline if under 60 KB otherwise the path, the verdict JSON schema, and the reviewer prompt from `prompts/reviewer.md`. It never includes the builder's summary text. For `pr_review` tasks the diff comes from `gh pr diff <n>` captured by `task:new --pr`.

## Verdict schema (`verdict.json`)

```json
{
  "verdict_version": "1",
  "decision": "approve | changes_requested | reject",
  "summary": "one paragraph, no more than 600 characters",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker | major | minor | nit",
      "file": "src/x.mjs",
      "line": 42,
      "claim": "what is wrong, one sentence",
      "evidence": "the exact lines or behaviour that show it, quoted from the diff",
      "suggested_fix": "optional, one sentence"
    }
  ],
  "tests_touched": false,
  "tests_touched_justified": null,
  "scope_exceeded": false,
  "confidence": 0.0
}
```

Validation rules enforced by `cortexctl verdict` (exit 5 on failure): `decision` in the enum; `reject` and `changes_requested` require at least one finding of severity `major` or `blocker`; `approve` allows only `minor` and `nit`; every finding has `file` and `claim`; `evidence` is required for `blocker` and `major`; `confidence` between 0 and 1; when the post run guard recorded touched test files, `tests_touched` must be `true` and `tests_touched_justified` must be a boolean with a reason in `summary`.

## Challenge cycle

At most one. Sequence: architect reads the verdict summary from the packet, decides to challenge, writes `cortexctl msg --task <id> --kind challenge --from architect --to reviewer --body <file>`; only now may the builder's `reasoning.md` be attached to the challenge. The reviewer runs again with the challenge and issues a verdict with `challenge_seq = 1`. A second challenge exits 3 with `challenge_limit`. The architect is the final arbiter on every `changes_requested`: it accepts or rejects each finding with a logged reason in an `agent_messages` row of kind `rebuttal`. The reviewer advises, it does not command.

## Adjudication

`cortexctl adjudicate --task <id> --real <n> --noise <n> [--escaped <n>] [--minutes <m>] [--note "..."]`. A human, not a model, decides which findings were real. Writes `findings_real`, `findings_noise` on the latest verdict, `defects_escaped` on the task, and a `human_interventions` row of kind `adjudicate`. `report` marks any task without adjudication as `unadjudicated` and excludes it from precision statistics. Reviewer precision per provider and task class is `sum(findings_real) / sum(findings_total)` over adjudicated verdicts; it is the number that later decides whether a reviewer earns its cost for a task class.

## PR triage mode

The reviewer prompt in the brief (`# Reviewer instructions`) is `prompts/pr-triage-reviewer.md` for a `pr_review` task and `prompts/reviewer.md` for every other kind (`src/review.mjs`'s `readReviewerPrompt`, keyed off `task.kind` the same way the diff source above it is) - the PR triage prompt never mentions `builder/` or `reasoning.md`, because no builder run exists to avoid in this mode. The brief also states the `summary` field's 600-character cap as its own separate, blunt paragraph, not only inside the schema's JSON example: three real verdicts from a single Phase 1a dry-run reviewer model each exceeded it (754, 937, 967 characters, every one rejected by `cortexctl verdict` with exit 5) before this paragraph existed.

For an existing pull request rather than an issue: `cortexctl task:new --kind pr_review --repo owner/name --pr <n> --arm tri|control`. The kit captures `gh pr view <n> --repo owner/name --json number,title,body,baseRefOid,headRefOid,baseRefName,headRefName` and `gh pr diff <n> --repo owner/name` (argv, `shell: false`; `gh pr diff`'s stdout is streamed straight to a temp file, never buffered in memory, so an oversized diff cannot fail with a buffer overflow before the size guard below even applies) into the run dir: the diff, redacted line by line, as `<runs>/<task>/pr.diff`; the redacted title and body as an `agent_messages` brief; `pr_number`, `pr_repo`, `base_sha` (`baseRefOid`), and `head_sha` (`headRefOid`, `null` when gh's own JSON omits either) on the task itself. Every one of these writes happens against a temp path under `<runs>/.tmp/` and the ledger transaction that inserts the task/brief/artifact rows; `<runs>/<task>/` itself and its `pr.diff` are only created after that transaction commits, and the temp file is deleted on any failure - a `gh` failure or a database constraint failure (a bad `--parent`, for instance) never leaves a half-populated task, a stray run directory, or a stray temp file behind. A diff over 2,000,000 bytes is still written in full, with a note on the task and a warning on stderr, never truncated. Tri arm runs two blind reviewers from different labs and the architect merges their verdicts into one triage note; control arm runs one. The human adjudicates both. Output for the PR author or maintainer is `cortexctl triage:note --task <id>`, a markdown comment with the agreed findings, the disagreements, and the ledger ids, suitable for pasting into the PR. The kit never posts to GitHub on its own.

## Second opinion

An optional third read from a free tier or public only provider on public material. Stored as a verdict from agent `second-opinion` with `blind = 1`. Never on the critical path; the loop completes without it.
