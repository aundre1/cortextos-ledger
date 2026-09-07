# Example: triaging an existing pull request

This is for a maintainer who already has an open PR and wants two independent
reads on it before deciding what to do, rather than a full issue-to-patch
loop. No builder run happens here; the PR's own commits are the material
under review.

## 1. Open the triage task

```bash
task=$(cortexctl task:new --repo owner/name --title "Triage PR #742" \
  --class pr-triage --arm tri --kind pr_review --pr 742)
```

This captures `gh pr view 742 --json title,body,baseRefOid,headRefOid,files`
and `gh pr diff 742` into the run directory; the kit reads the PR, it never
writes to it.

## 2. Run two blind reviewers from different labs

Both use `prompts/pr-triage-reviewer.md`. Neither sees the other's verdict.

```bash
cortexctl review:brief --task "$task" --reviewer reviewer
run_a=$(cortexctl run:launch --task "$task" --agent reviewer --prompt-file ./reviewer/brief.md)
cortexctl watch --run "$run_a"
cortexctl verdict --task "$task" --run "$run_a" --reviewer reviewer \
  --provider google --model gemini-3.8-flash --file ./reviewer/verdict.json

cortexctl review:brief --task "$task" --reviewer reviewer_b
run_b=$(cortexctl run:launch --task "$task" --agent reviewer_b --prompt-file ./reviewer_b/brief.md)
cortexctl watch --run "$run_b"
cortexctl verdict --task "$task" --run "$run_b" --reviewer reviewer_b \
  --provider openai --model gpt-5.6 --file ./reviewer_b/verdict.json
```

`reviewer` and `reviewer_b` must be different labs (`docs/review-protocol.md`);
picking the same provider for both defeats the point and the ledger has no
way to catch that for you.

## 3. A human adjudicates both verdicts

```bash
cortexctl adjudicate --task "$task" --real 2 --noise 1 --minutes 15 \
  --note "reviewer found a real race condition, reviewer_b's second finding was a style preference, both agreed the migration was missing a down-path"
```

## 4. Generate the triage note for the PR

```bash
cortexctl triage:note --task "$task"
```

This prints a markdown comment with the agreed findings, the disagreements
between the two reviewers, and the ledger ids, meant to be pasted by the
maintainer into the PR by hand. The kit never posts to GitHub on its own.

## 5. Close the task

```bash
cortexctl task:close --task "$task" --outcome revised --pr https://github.com/owner/name/pull/742
```

Use `revised` if the maintainer asked for changes based on the triage,
`first_pass` if it merged as is, `failed` if it was closed without merging.
