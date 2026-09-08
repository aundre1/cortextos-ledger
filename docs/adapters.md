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

Concurrency note: two OpenCode processes sharing one OpenCode data directory have deadlocked on OpenCode's own database. The launcher sets a per agent `XDG_DATA_HOME` so builder and reviewer can run sequentially or in parallel without sharing state. This is the *same* environment variable on every platform, Windows included -- see "opencode: credential forwarding (D1)" below for why, and for the correction this made to what this doc used to say here (`LOCALAPPDATA`, which OpenCode never reads). If that isolation is found not to hold on a given OpenCode version, `run:start` refuses a second concurrent OpenCode run on the same host with exit 6 and reason `opencode_serial`.

Model rule: any model string containing `anthropic` or `claude` is refused by this adapter with exit 1. Anthropic subscription OAuth may not be used inside third party harnesses; API keys are the operator's decision and live outside this kit.

### opencode: credential forwarding (D1)

Isolating `XDG_DATA_HOME` per agent (the concurrency note above) has a side effect: OpenCode keeps its own `auth.json` -- every provider credential, OAuth tokens included -- inside that same data directory, so an isolated run has none and every provider call 401s. Verified directly from the OpenCode source (`sst/opencode`, tag `v1.18.27`, fetched from `raw.githubusercontent.com`):

- `auth.json`'s path: `const file = path.join(Global.Path.data, "auth.json")` -- `packages/opencode/src/auth/index.ts:10`.
- `Global.Path.data`: `const data = path.join(xdgData!, app)` where `app = "opencode"` -- `packages/core/src/global.ts:11` (imports `xdgData` from the `xdg-basedir` npm package, `packages/core/src/global.ts:3`).
- `xdg-basedir`'s own resolution (`sindresorhus/xdg-basedir`, `index.js`): `export const xdgData = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share')`. This is **not** platform branched -- the exact same rule runs on win32. `os.homedir()` there resolves to `%USERPROFILE%`, so with no `XDG_DATA_HOME` set the real default on Windows is `%USERPROFILE%\.local\share\opencode`, never `%LOCALAPPDATA%\opencode` -- a Windows-idiomatic guess this kit's own code made in review round 1 and is now correcting (the `LOCALAPPDATA` env var this adapter used to also set alongside `XDG_DATA_HOME` on win32 did nothing: OpenCode never reads it).
- The override this task looked for first (an auth path independent of data home) exists, though as a *content* override rather than a *path* one: `Auth.all()` checks `process.env.OPENCODE_AUTH_CONTENT` before ever touching the file -- `if (process.env.OPENCODE_AUTH_CONTENT) { try { return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) } catch (err) {} }`, `packages/opencode/src/auth/index.ts:59-61`. `Auth.set()`/`Auth.remove()` (lines 79, 88) still only ever write the real file -- this override is read-only, which is exactly the shape this kit needs (the isolated run only ever needs to *read* credentials, never runs `opencode auth login` itself).

**Design chosen (preference 1 from this task's own instructions -- an override independent of data home):** at launch, `src/adapters/opencode.mjs`'s `buildArgv` resolves the operator's *real* OpenCode data home the same way OpenCode itself does (`resolveRealOpencodeDataHome`, `env.XDG_DATA_HOME` or `<homedir>/.local/share`), reads `<that>/opencode/auth.json` if it exists, and sets the child's `OPENCODE_AUTH_CONTENT` to its exact raw bytes -- entirely independent of the isolated `XDG_DATA_HOME` this same launch sets for sessions/its own sqlite db/snapshots/logs. Nothing is ever written to disk anywhere under the isolated run directory: there is no file to `chmod 0o600` and nothing to delete in a `finally` or the watchdog kill path (preference 2 in the task's instructions, the copy-then-delete design, is therefore not needed). An `events.jsonl` event is written either way: `credentials.forwarded` with the list of provider ids found in auth.json (`Object.keys(...)`, never a token/key/refresh value) when it exists; `credentials.missing` (severity `warn`) naming the path checked when it does not, so a missing auth.json is visible in the run's own event log rather than only inferred from a 401 buried in `out.txt`. `cortexctl doctor` reports `opencode auth.json: found at <path> (N providers)` or `not found` whenever any configured agent uses adapter `opencode`.

### opencode: agent definition and permission binding (D2)

OpenCode's own agents are defined in *its* config (`opencode.json`/`opencode.jsonc`, or an env-injected equivalent -- see below), under `agent.<name>`, never in this kit's config -- and the isolated launch environment ships none, so `--agent <name>` always falls back to OpenCode's default agent, silently dropping whatever `permission` block a reviewer needed. Verified from source (same tag):

- The exact fallback text (`out.txt` shows this on the real Windows run this task investigated): `` `agent "${name}" not found. Falling back to default agent` `` -- `packages/opencode/src/cli/cmd/run.ts:606` (function `localAgent`). A second, related message when the named agent exists but is `mode: "subagent"`: `` `agent "${name}" is a subagent, not a primary agent. Falling back to default agent` `` -- same file, line 614. Both are checked by `createStreamParser()`'s `push()` (in the `JSON.parse` catch branch, since neither line is JSON) and turned into an `agent.fallback` event, severity `warn`, naming the agent and which of the two reasons fired.
- `mode` does matter for `--agent`, but only to rule out `"subagent"` -- `run.ts:610` and `:649`. A custom top-level `config.agent.<name>` entry with no `mode` given defaults to `mode: "all"` (`packages/opencode/src/agent/agent.ts:276`), which already satisfies that gate; this kit's own generated definitions set `mode: "primary"` explicitly anyway, unambiguous and matching the convention for an agent invoked directly.
- The agent schema (`packages/core/src/v1/config/agent.ts`): `model`, `variant`, `temperature`, `top_p`, `prompt`, `mode` (`"subagent" | "primary" | "all"`), `permission`, plus a few fields this kit does not use (`steps`/`maxSteps`, `color`, `hidden`, `options`, the deprecated `tools`).
- The permission schema (`packages/core/src/v1/config/permission.ts`): a bare `"ask" | "allow" | "deny"`, or an object keyed by `read`/`edit`/`glob`/`grep`/`list`/`bash`/`task`/`external_directory`/`todowrite`/`question`/`webfetch`/`websearch`/`lsp`/`doom_loop`/`skill`, each itself either a bare action or (for the `Rule`-typed keys, `bash` included) a glob-pattern -> action map, with key order preserved for match precedence (the file's own comment: "Runtime config parsing uses Effect's `propertyOrder: 'original'` parse option so user key order is preserved for permission precedence"). `community/agents/blind-reviewer/config.json`'s `permission` block is already written in exactly this shape (verified byte for byte against this schema by this task) and is carried over unmodified by the translation below.
- The injection mechanism: `OPENCODE_CONFIG_CONTENT`, an env var carrying literal config JSON, read before any config file (`packages/opencode/src/config/config.ts:482-490`) -- the same env-var-content mechanism `OPENCODE_AUTH_CONTENT` uses for auth.json above, so nothing is written to disk here either. (`OPENCODE_CONFIG`, a single file path, and `OPENCODE_CONFIG_DIR`, a directory -- `packages/core/src/flag/flag.ts:21-22,63-64`, `packages/opencode/src/config/config.ts:415-433` -- also exist as env-driven overrides independent of `XDG_CONFIG_HOME`, but content injection needs no temp file at all, so it is what this kit uses.)

**Design chosen:** at launch, `buildOpencodeAgentDefinition` resolves one `agent.<name>` definition and sets `OPENCODE_CONFIG_CONTENT` to `{"agent":{"<name>": {...}}}`, in this precedence: (1) `config.agents.<name>.opencode`, a raw OpenCode-shaped object used verbatim; (2) `config.agents.<name>.template`, a path to a `community/agents/<x>/config.json`-style file, translated into OpenCode's schema (its `permission` block copied through unmodified; its `prompt` field's own `{file:./prompts/x.md}` convention -- this kit's, not OpenCode's -- resolved against this package's own root, since the shipped templates have no `prompts/` directory of their own -- see the `OPEN QUESTION` this raised in the wave log); (3) neither: a minimal `{ model }` only, which is already enough to stop the "not found" fallback (any `agent.<name>` entry, however small, makes OpenCode's own lookup succeed), just with OpenCode's own unrestricted default permissions. Whichever tier resolves, `config.agents.<name>.read_only: true` is now enforced, not merely documented: `buildOpencodeAgentDefinition` throws (exit 1) if the resulting permission does not actually deny `edit`, closing the gap between docs/security.md's existing claim ("the adapters refuse to launch a reviewer with write permissions when the config says `read_only: true`") and what the code did before this task (nothing).

## fake

Deterministic adapter for tests. Reads a fixture describing the events to emit, the files to write into the worktree, the exit code, and the elapsed time. Used to prove every guard and limit fires without spending a token.

## spawn helper and credential boundary

`spawn.mjs` creates the child in a new process group (`detached: true` on POSIX, `CREATE_NEW_PROCESS_GROUP` semantics on Windows through `windowsHide` plus `detached`), writes `pid.txt`, redirects stdout and stderr to `out.txt`, and writes `exit.txt`, `elapsed_ms.txt`, and `done.marker` on close. `credential-boundary.mjs` is applied to every spawn (see `security.md`).

## Windows command resolution

Every harness this kit spawns (`claude`, `codex`, `opencode`) plus `gh` (task capture) and `npm` (the packaging scripts) is invoked by bare name with `shell: false`, always. On POSIX that is exactly right -- `spawn`'s own PATH search finds the real executable. On Windows, a harness installed the normal way (`npm i -g`) exists on PATH only as `<name>.cmd`/`<name>.ps1` (npm's own shim convention): Node's `spawn` with `shell: false` performs PATHEXT-aware resolution, but that covers `.exe`/`.com`/`.bat` -- never `.cmd` -- and, since the CVE-2024-27980 fix, spawning a `.cmd`/`.bat` directly without `shell: true` throws `EINVAL` rather than doing the wrong thing silently.

`resolveCommand(name, opts)` (`src/adapters/resolve-command.mjs`, re-exported from `spawn.mjs`) finds the real target behind a `.cmd` shim so every spawn always has something it can actually exec, with `shell: false` unchanged. `opts` overrides `platform`/`env`/`execPath`/`readFile` (each defaulting to the real thing) so the whole rule set is unit-testable on any host. The rules, in order:

1. **Not Windows.** `{ cmd: name, prefixArgs: [] }`, unchanged -- this is a pure no-op everywhere except win32.
2. **Already explicit.** `name` containing a path separator, or already ending in `.exe`/`.com`, is used exactly as given. A name already ending in `.cmd`/`.bat` still goes through rule 5's shim parser (an operator who points `config.tools` straight at a `.cmd` file gets it parsed, not blindly executed).
3. **Every PATH entry's `<name>.exe` then `<name>.com`, first hit wins.** This whole pass runs across *every* PATH entry before rule 4 ever looks at a `.cmd` -- an `.exe` anywhere on PATH beats a `.cmd` shim earlier on PATH (the reference machine's `claude.exe` ahead of an npm `claude.cmd` shim is exactly this case).
4. **The first `<name>.cmd` on PATH, parsed as an npm shim.** npm's shim generator (cmd-shim) emits exactly two shapes: a *direct-exe* shim (`"%dp0%\node_modules\<pkgpath>\<file>.exe"   %*` -- the reference machine's `opencode.cmd`) resolves to that `.exe` directly; a *node-launcher* shim (`"%_prog%"  "%dp0%\node_modules\<pkgpath>\<file>.js" %*`, or the older `"%dp0%\node.exe" ...` form -- the reference machine's `codex.cmd`, and `npm.cmd` itself) resolves to `{ cmd: execPath, prefixArgs: [<the .js path>] }`. Either way the target is verified with `fs.existsSync` before it is trusted; a target that does not exist falls through to rule 5.
5. **Unparseable (or missing-target) `.cmd`/`.bat`: the `cmd.exe` fallback.** `{ cmd: env.ComSpec ?? 'cmd.exe', prefixArgs: ['/d', '/s', '/c', <escaped shim path>], escapeArgs: true }`. `escapeArgs: true` tells the caller (`applyResolvedCommand`) to run every argument it appends through the same escaping function (`escapeCmdArg`, ported from cross-spawn's algorithm rather than adding a dependency -- see `security.md`). This is the one path where the kit still ends up executing through a shell-like program; it is a last resort, not the common case.
6. **Nothing found anywhere on PATH.** `{ cmd: name, prefixArgs: [], resolvedFrom: null }` -- the caller spawns `name` itself and gets the platform's own `ENOENT`. `preflight` refuses outright (exit 1, reason `command_not_found`) rather than let a launch reach this silently; `doctor` prints it as `NOT FOUND` for every configured adapter and for `gh`.

`resolvedFrom` on the result is a short human string naming which rule fired (`posix`, `given`, `exe on PATH`, `com on PATH`, `npm shim -> exe`, `npm shim -> node + js`, `cmd.exe fallback`, or `null`) -- `doctor` and `preflight` print it verbatim (see `guards.md` and `cli.md`).

### `config.tools`: manual overrides

`config.tools` is an optional object of `{ "<name>": [<cmd>, ...args] }` argv arrays that skip resolution entirely for that tool: `cmd = override[0]`, `prefixArgs = override.slice(1)`. This is the escape hatch for a PATH an operator cannot fix (a harness installed somewhere resolution does not look, a wrapper script, a version pin):

```json
"tools": {
  "gh": ["C:/tools/gh.exe"],
  "opencode": ["C:/tools/opencode/node_modules/opencode-ai/bin/opencode.exe"]
}
```

**Precedence** (highest wins): an adapter-level `cmd` (the review round 1 test-harness override, `config.adapters.<name>.cmd`) wins outright over everything, since that already exists specifically to stand a stub in for the real CLI; then `config.tools.<name>`; then `resolveCommand(name, ...)`. `run:start`/`run:launch` pass the resolved adapter's name through automatically; `task:new`'s `gh` capture reads `config.tools.gh` the same way. Every adapter's own `buildArgv` documents this precedence again at the point it applies it.

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
