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
2. Harness permissions: reviewer agents are `read_only: true` in the adapter config; the OpenCode agent definition denies `edit`, `write`, `bash` except a fixed allowlist (`git diff`, `git show`, test commands from config).
3. Ledger: the first verdict is stored with `blind = 1` and `challenge_seq = 0`. If the reviewer's `events.jsonl` shows a read of any path under `builder/` or any file named `reasoning.md`, `verdict` stores `blind = 0` and writes escalation `verdict_invalid` severity `warn`. The verdict is kept, flagged, and excluded from blind statistics.

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

For an existing pull request rather than an issue: `cortexctl task:new --kind pr_review --repo owner/name --pr <n> --arm tri|control`. The kit captures `gh pr view <n> --json title,body,baseRefOid,headRefOid,files` and `gh pr diff <n>` into the run dir. Tri arm runs two blind reviewers from different labs and the architect merges their verdicts into one triage note; control arm runs one. The human adjudicates both. Output for the PR author or maintainer is `cortexctl triage:note --task <id>`, a markdown comment with the agreed findings, the disagreements, and the ledger ids, suitable for pasting into the PR. The kit never posts to GitHub on its own.

## Second opinion

An optional third read from a free tier or public only provider on public material. Stored as a verdict from agent `second-opinion` with `blind = 1`. Never on the critical path; the loop completes without it.
