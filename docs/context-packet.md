# Context packet

The context packet is the "where we left off" file the community keeps rebuilding by hand, and it is the boot contract described for CortextOS V2 by the community this kit was built for: the harness receives a packet at boot instead of a wall of history. This kit emits it from the ledger so every harness, on every machine, starts from the same compact truth.

## Command

```
cortexctl packet --task <id> [--format json|md|both] [--max-bytes 8000] [--out <dir>]
cortexctl packet --board [--owner <id>] [--format json|md|both] [--max-bytes 12000]
```

Default format is `both`. Default out dir is the task's run dir (`<runs>/<task-id>/packet.json` and `packet.md`) or `<runs>/board/` for the board packet. The command also inserts an `artifacts` row of kind `packet` and an `agent_messages` row of kind `packet` from `ledger` to the task owner, so the ledger shows when a packet was handed out.

## Task packet schema (`packet.json`)

```json
{
  "packet_version": "1",
  "generated_at": "2026-09-07T01:00:00Z",
  "task": {
    "id": "t_...", "title": "...", "kind": "implement", "task_class": "ci-hardening", "arm": "tri",
    "repo": "owner/name", "issue_number": 208, "pr_number": null,
    "status": "input_required", "outcome": null, "owner": "owner1", "priority": 2, "due_at": null,
    "base_commit": "abc123", "branch": "cortexos/issue-208-tri", "worktree": "/abs/path"
  },
  "limits": { "attempts_used": 2, "attempts_max": 3, "spend_used_usd": 1.92, "spend_max_usd": 5.0,
              "challenges_used": 0, "challenges_max": 1, "wallclock_s": 5400 },
  "runs": [ { "id": "r_...", "seq": 1, "agent": "builder", "model": "...", "status": "fail", "exit_code": 1,
              "elapsed_s": 412, "cost_usd": 0.91, "halted_reason": null, "summary": "..." } ],
  "latest_verdict": { "decision": "changes_requested", "findings_total": 3, "findings_real": null,
                      "top_findings": [ { "severity": "major", "file": "...", "claim": "..." } ] },
  "tests": { "last_status": "fail", "passed": 41, "failed": 2, "suite": "pnpm test" },
  "artifacts": [ { "kind": "diff", "path": "...", "bytes": 1820 }, { "kind": "reasoning", "path": "..." } ],
  "open_escalations": [ { "reason": "files_touched", "severity": "halt", "detail": "12 files > 10" } ],
  "recent_messages": [ { "at": "...", "from": "architect", "to": "builder", "kind": "brief", "excerpt": "..." } ],
  "next_action": { "actor": "human", "action": "resolve escalation files_touched, then run:start builder attempt 3", "command": "cortexctl task:resolve --task t_... --note '...'" }
}
```

`next_action` is derived, never stored: `submitted` → start builder; `working` with a live run → wait; `working` with a completed builder run and no verdict on a `tri` task → start reviewer; verdict `changes_requested` with attempts left → start builder; `input_required` → the human resolves the named escalation; `completed` → nothing. When the derivation is ambiguous the actor is `human` and the action says why.

## Markdown packet (`packet.md`)

Under 8,000 bytes by default. Order: one line status, limits line, next action with the exact command, the last verdict's top three findings, the last test result, the run table, open escalations, artifact paths. Excerpts of messages are truncated at 300 characters. The markdown carries no diff and no reasoning text, only paths; a harness that needs the diff reads the file.

## Board packet

Lists tasks by owner, then by `input_required` first, then priority, then due date. Each task gets one line plus its `next_action`. Intended for a CortextOS heartbeat: an agent whose heartbeat cron says "read the board packet and act on anything assigned to you" gets a bounded, current, machine readable brief instead of scanning an inbox.

## Size discipline

If the packet exceeds `--max-bytes`, trim in this order: recent messages, artifacts beyond the newest three, runs beyond the newest three, findings beyond the top three. The limits, status, and next action are never trimmed. The command prints `truncated: true` in JSON and a final `(truncated)` line in markdown when trimming happened.

## Consumers

- A CortextOS agent template in `community/agents/` runs `cortexctl packet --board --owner $AGENT` at heartbeat.
- The tri model relay's Architect reads only the task packet and the compare output, never the raw run directories.
- A human opening a laptop after a night run reads `packet.md`.

## Non goals

The packet is not memory and not a transcript. It contains no chain of thought from any agent. Adding conversational history to it is refused as a design change, because a packet that grows with history stops being a packet.
