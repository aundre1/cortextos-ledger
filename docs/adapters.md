# Adapters

One interface, four implementations. An adapter launches a harness for one run, applies the credential boundary, and reports what happened. It never decides retries, never reads the ledger, and never merges.

## Interface

```js
export async function run({
  prompt,          // string, the full brief
  cwd,             // absolute worktree path
  agent,           // agent name inside the harness (opencode agent, codex profile) or null
  model,           // provider/model string the harness understands
  outDir,          // absolute run out dir; adapter writes events.jsonl, out.txt, exit.txt, done.marker, pid.txt, elapsed_ms.txt
  timeoutMs,       // hard ceiling; adapter must not exceed it even if the watchdog is absent
  env,             // extra env, already filtered by the credential boundary
  detach,          // boolean; true returns immediately after spawn with { pid }
  onEvent          // optional callback for normalized events
}) => ({ pid, exitCode, sessionId, tokensIn, tokensOut, costUsd, requests, toolCalls, summary })
```

When `detach` is true the adapter returns after spawn and the launcher relies on the watchdog plus `done.marker`. When false it awaits completion and fills every field it can.

## Normalized event format (`events.jsonl`)

One JSON object per line:

```json
{"ts":"2026-09-07T01:02:03.456Z","type":"session.start","session_id":"...","agent":"builder","model":"..."}
{"ts":"...","type":"tool.call","tool":"read","args_summary":"path=src/x.mjs"}
{"ts":"...","type":"tool.result","tool":"read","ok":true,"ms":12}
{"ts":"...","type":"tool.result","tool":"bash","ok":false,"error":"exit 1: ..."}
{"ts":"...","type":"message","role":"assistant","tokens_in":1200,"tokens_out":340,"cost_usd":0.0041}
{"ts":"...","type":"session.end","exit_code":0,"tokens_in":..,"tokens_out":..,"cost_usd":..,"requests":..}
```

Adapters translate their harness's native stream into this format. `ingest` reads only this format. Never log tool arguments in full; `args_summary` is capped at 200 characters and secrets patterns are redacted before write.

## claude (Claude Code)

Command: `claude -p <prompt> --output-format stream-json --verbose --model <model>` with `cwd`. Prompt passed as an argument, never stdin. Parse the stream: `assistant` messages carry usage; the final `result` message carries `total_cost_usd`, `duration_ms`, `session_id`, `num_turns`. Cost is a client side estimate and is recorded with `cost_usage.source = 'plugin'`. Subagent messages carry `parent_tool_use_id`; count them as tool calls. Permissions: pass `--allowedTools` from config; never pass `--dangerously-skip-permissions` from the kit, the operator opts into that in their own settings.

Subscription rule: the kit strips every `ANTHROPIC_*` variable from the child environment when the operator's config says `auth: subscription`, so Claude Code cannot fall back to API billing. This is the API key refusal guard the community asked for, and it is a boundary, not a prompt.

## codex (Codex CLI)

Command: `codex exec --json --sandbox <mode> --cd <cwd> -o <outDir>/last-message.md <prompt>` with stdin closed (`stdin: 'ignore'`) because an open stdin hangs the process. `--sandbox` defaults to `read-only` for reviewer roles and `workspace-write` for builders; `danger-full-access` is refused by the adapter. For resumed threads use `codex exec resume <thread_id>` and pass `-c sandbox_mode="read-only"` explicitly, because resume does not accept `--sandbox` and would otherwise inherit whatever `~/.codex/config.toml` says. Parse the NDJSON for `thread.started` (session id), item events (tool calls), and `turn.completed` usage when present. Usage fields that Codex does not emit are recorded as zero with `source = 'manual'` so they are visibly missing rather than silently wrong.

## opencode (OpenCode)

Command: `opencode run --agent <agent> --model <model> --format json <prompt>` with `cwd`, prompt as an argument. Because the JSON stream has been observed to end before the final step event, the adapter relies on the kit's OpenCode plugin (`plugins/opencode/cortex-ledger.js`) for the authoritative `events.jsonl`, and treats the process exit code plus `done.marker` as completion. The plugin hooks `tool.execute.before`, `tool.execute.after`, and session events, appends to `events.jsonl`, and holds no database handle; that is what keeps two OpenCode processes from deadlocking on a shared SQLite file.

Concurrency note: two OpenCode processes sharing one OpenCode data directory have deadlocked on OpenCode's own database. The launcher sets a per agent `XDG_DATA_HOME` (Windows: the equivalent OpenCode data path env) so builder and reviewer can run sequentially or in parallel without sharing state. If that isolation is found not to hold on a given OpenCode version, `run:start` refuses a second concurrent OpenCode run on the same host with exit 6 and reason `opencode_serial`.

Model rule: any model string containing `anthropic` or `claude` is refused by this adapter with exit 1. Anthropic subscription OAuth may not be used inside third party harnesses; API keys are the operator's decision and live outside this kit.

## fake

Deterministic adapter for tests. Reads a fixture describing the events to emit, the files to write into the worktree, the exit code, and the elapsed time. Used to prove every guard and limit fires without spending a token.

## spawn helper and credential boundary

`spawn.mjs` creates the child in a new process group (`detached: true` on POSIX, `CREATE_NEW_PROCESS_GROUP` semantics on Windows through `windowsHide` plus `detached`), writes `pid.txt`, redirects stdout and stderr to `out.txt`, and writes `exit.txt`, `elapsed_ms.txt`, and `done.marker` on close. `credential-boundary.mjs` is applied to every spawn (see `security.md`).

## Adapter selection

`cortexctl run:start --adapter <claude|codex|opencode|fake>` or from the agent definition in config:

```json
"agents": {
  "builder":   { "adapter": "opencode", "agent": "builder",  "provider": "opencode-go", "model": "opencode/deepseek-v4" },
  "solo":      { "adapter": "opencode", "agent": "solo",     "provider": "opencode-go", "model": "opencode/deepseek-v4" },
  "reviewer":  { "adapter": "opencode", "agent": "reviewer", "provider": "opencode-go", "model": "opencode/kimi-k2.6", "read_only": true },
  "reviewer_b":{ "adapter": "codex",    "agent": null,       "provider": "openai",      "model": "gpt-5.6",        "read_only": true },
  "architect": { "adapter": "claude",   "agent": null,       "provider": "anthropic",   "model": "claude-opus-5",  "auth": "subscription" }
}
```

The model strings above are placeholders for the operator to set; the kit ships no default models. One agent binds one provider and one model. Changing the model means a new agent name.

`examples/config.opencode-go.json` is a worked instance of this block for an
operator on an OpenCode Go subscription: `builder`/`solo` on
adapter `opencode`/provider `opencode-go`, `reviewer`/`reviewer_b` each on a
different lab (`google`, `openai`) so review stays independent, every model
left blank with a `_model_note` per the placeholder convention in
`community/agents/blind-reviewer/config.json`. See `docs/measurement.md`
"OpenCode Go as the builder lane" for the quota windows that make the
subscription's ceiling actually enforced and for why its USD-equivalent cost
figures are not directly comparable to an API-billed lane's.
