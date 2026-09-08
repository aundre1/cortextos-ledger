# Security and boundaries

## Credential boundary

Applied to every child process the kit spawns. Source of truth is `src/adapters/credential-boundary.mjs`.

1. Always removed from the child environment: every variable matching `^ANTHROPIC_`, `^CLAUDE_`, `^CORTEX_PROXY_`. Claude Code under a subscription re authenticates from its own keychain; nothing in the kit can push it onto API billing.
2. Additionally removed when spawning the `claude` adapter: `^OPENAI_`, `^NVIDIA_`, `^NIM_`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`. One harness, one provider.
3. The `opencode` adapter refuses any model string containing `claude` or `anthropic` (exit 1). Anthropic subscription OAuth may not be used in third party harnesses. This is a policy fact, and the kit encodes it rather than leaving it to memory.
4. Providers marked `public_only` in config require `--public` at `run:start`; the flag is recorded on the run so an audit can see what was sent where.

The boundary is a pure function `filterEnv(env, { adapter })` with a unit test that asserts each rule. Operators who want a different policy edit the config allowlist, not the code.

## Secrets scan

Preflight scans the worktree for key patterns and secret file names (see `guards.md`). Findings report path and line only. The scanner never writes matched values to the ledger, to stdout, or to `events.jsonl`. Event summaries pass through the same redaction before write.

## What the ledger stores

Ids, timestamps, counts, costs, decisions, paths, hashes, summaries, and finding text written by reviewers. It stores no diffs, no file contents, no chain of thought. `agent_messages.body` holds briefs, challenges, and rebuttals, which are working documents, so a ledger for a private repository is itself private.

## Public versus private in this repository

Public: everything under `src/`, `bin/`, `plugins/`, `prompts/`, `scripts/`, `community/`, `docs/`, `test/`, `examples/`. Every path in these folders is relative or config driven. No home directory, no username, no organisation name, no client name.

Never committed: `.cortex/` (database, runs), any `orgs/` content, any file matching the secrets patterns, any `events.jsonl`, any `reasoning.md`. `.gitignore` covers these and `scripts/publish-check` refuses to proceed if they are staged.

### Temporary files at rest

| Path | Contents | Lifetime |
|---|---|---|
| `<runs>/.tmp/<taskId>.pr.diff.raw` | An **unredacted** PR diff, streamed straight from `gh pr diff` before `task:new`'s PR capture redacts it (docs/review-protocol.md "PR triage mode") | Deleted immediately after redaction, in a `finally` around the capture so a `gh` failure or an exception during redaction/hashing also cleans it up. If `cortexctl` itself is killed (e.g. SIGKILL) mid-capture, before that `finally` runs, the file can survive on disk transiently -- it is swept (deleted, if older than 60 minutes) at the start of the next `init` or `task:new` call, whichever comes first. A sidecar `<taskId>.pr.diff.raw.pid`, written the moment the raw path is chosen and holding that writing process's pid, accompanies it: the sweep skips (and never deletes) any raw file whose sidecar names a still-alive pid, no matter how old its mtime looks, and removes the sidecar together with the raw file once it does delete it (or, in the normal case, in the same `finally` as the raw file itself) -- this is what keeps a slow but still-running capture, or a clock jumped forward past the 60 minute threshold, safe from a *concurrent* `init`/`task:new`'s sweep |

Nothing else the kit writes is ever unredacted at rest even transiently: `out.txt` is redacted line by line as it is written (not only after the run finishes), and every other diff/artifact the ledger records is the already-redacted file.

Community source material: this kit was shaped by problems raised in a private, paid community. The kit describes the failure modes it prevents in general terms. It quotes nobody and names nobody. Pull requests that add quotes or names from community calls are declined.

## Windows command-line fallback

Every spawn in this kit uses `shell: false`. The one exception -- and it is a fallback, not a default -- is `resolveCommand`'s last resort for a Windows `.cmd`/`.bat` shim it cannot parse into a real executable (`src/adapters/resolve-command.mjs`, `docs/adapters.md` "Windows command resolution" rule 5): it spawns `cmd.exe` itself (`/d /s /c <shim path>`) with the shim path and every argument passed through `escapeCmdArg` -- cross-spawn's escaping algorithm, ported here rather than adding a dependency: escape a literal `"` as `\"` (doubling any backslashes immediately before it, and any trailing backslashes so they cannot escape the closing quote), wrap the whole argument in quotes, then escape `cmd.exe`'s own metacharacters `()%!^"<>&|` with a leading `^` so `cmd.exe`'s parser does not act on them. This path is taken only when a `.cmd`/`.bat` shim exists on PATH and matches neither of npm's own two shim shapes (or its parsed target is missing on disk) -- it never runs for a plain `.exe`, and it never interprets a prompt or any other kit-controlled string as shell syntax, only the fixed argv the adapter itself built. `doctor` reports this path as `cmd.exe fallback` so an operator can see when it fires and set `config.tools.<name>` to bypass it.

## Permissions at the harness layer

Builder agents may edit and run commands but are denied `git push`, `git merge`, `git reset --hard`, `git branch -D`, `git checkout .`, and `gh pr merge`. Reviewer agents are read only. These live in the harness agent definitions shipped under `community/` and `examples/`, and the adapters refuse to launch a reviewer with write permissions when the config says `read_only: true`.

## Threat model the kit does not cover

Prompt injection through repository content, exfiltration by a harness over the network, and a compromised harness binary. Those are the harness's and the operator's responsibility. The kit reduces blast radius (worktrees, no merge, no secrets in the tree, one provider per child) and records what happened; it does not sandbox.
