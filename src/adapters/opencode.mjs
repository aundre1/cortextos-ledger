// docs/adapters.md "opencode (OpenCode)". Same interface as every adapter:
// buildArgv, parseStream, run(opts). `plugins/opencode/cortex-ledger.js` is
// authoritative for events.jsonl here - "the JSON stream has been observed
// to end before the final step event" (docs/adapters.md), so this adapter's
// own stdout parsing is a best-effort fallback only, used when the plugin's
// file is not found at `CORTEX_EVENTS_PATH`.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterEnv, rejectAnthropicModel, redact, relativizeToCwd } from './credential-boundary.mjs';
import { applyResolvedCommand, resolveConfiguredCommand } from './resolve-command.mjs';
import { normalizeExitCode } from '../exit-code.mjs';
import { choosePromptDelivery, promptDeliveryEvent } from './prompt-delivery.mjs';

const ARGS_SUMMARY_MAX = 200;
const NORMALIZED_TYPES = new Set(['session.start', 'tool.call', 'tool.result', 'message', 'session.end']);
// The `opencode run --format json` raw stdout shapes this parser translates
// (sst/opencode v1.18.27, packages/opencode/src/session/message-v2.ts's
// `Part` union and packages/opencode/src/cli/cmd/run.ts's JSON printer -
// see docs/adapters.md "opencode: parsing the real run --format json
// stream" for the full citation trail and a real captured example,
// test/fixtures/opencode-run.real.jsonl). `error`'s raw shape
// (`{"type":"error",...,"error":{"name":...,"data":{"message":...,
// "statusCode":...}}}`) is intentionally kept out of NORMALIZED_TYPES above
// - this kit has no prior normalized-and-passed-through `error` event, so
// there is no ambiguity to resolve between "already normalized" and "raw
// OpenCode shape" for this one type; every `type: 'error'` line reaching
// this parser is the raw shape. Any other top-level `type` is counted as an
// unparsed line (session.end's `unparsed_lines`) rather than silently
// dropped with no trace.
const RAW_STREAM_TYPES = new Set(['step_start', 'tool_use', 'step_finish', 'text', 'error']);

// This module's own directory is src/adapters/, two levels under the repo
// root - used only to resolve a community agent template's `{file:...}`
// prompt references (see resolvePromptField below); never used for anything
// that ships to an operator's own project.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

// D2 (this executor's task card): the exact warning text OpenCode 1.18.27
// prints on stdout when `--agent <name>` does not resolve, read verbatim
// from source - packages/opencode/src/cli/cmd/run.ts:606 (`agent "${name}"
// not found. Falling back to default agent`) and :614 (`agent "${name}" is a
// subagent, not a primary agent. Falling back to default agent`, the
// mode==='subagent' case - see docs/adapters.md "opencode: agent definition
// and permission binding" for the full citation trail). Neither line is
// JSON, so createStreamParser()'s push() below matches them in the
// JSON.parse catch block, not as a normalized type.
const AGENT_NOT_FOUND_RE = /agent "([^"]+)" not found\. Falling back to default agent/;
const AGENT_SUBAGENT_RE = /agent "([^"]+)" is a subagent, not a primary agent\. Falling back to default agent/;

/**
 * `cwd`, when given, relativizes any string in `value` equal to or starting
 * with it (see `relativizeToCwd`) before redaction/capping - a real run
 * captured `read`'s own `state.input.filePath` as the operator's literal
 * absolute worktree path (a `D:\...` path on Windows); this is how it never
 * reaches `args_summary`/`error` on disk again. `redact()` still runs
 * unconditionally afterward (secrets patterns are not paths and are not
 * cwd-shaped).
 */
function capText(value, cwd) {
  const relativized = cwd ? relativizeToCwd(value, cwd) : value;
  const text = typeof relativized === 'string' ? relativized : JSON.stringify(relativized ?? {});
  const safe = redact(text);
  return safe.length > ARGS_SUMMARY_MAX ? safe.slice(0, ARGS_SUMMARY_MAX) : safe;
}

// ---------------------------------------------------------------------------
// D1: credential forwarding into the isolated data dir
// ---------------------------------------------------------------------------
//
// See docs/adapters.md "opencode: credential forwarding (D1)" for the full
// citation trail. Summary: OpenCode's own `auth.json` lives at
// `path.join(Global.Path.data, "auth.json")` (packages/opencode/src/auth/
// index.ts:10) - the *same* directory this adapter isolates per agent via
// `XDG_DATA_HOME`, so an isolated run has no credentials and every provider
// call 401s. But `Auth.all()` (same file, lines 58-63) reads
// `process.env.OPENCODE_AUTH_CONTENT` first, when set, and returns
// `JSON.parse(...)` of it directly - entirely bypassing `Global.Path.data`.
// This is preference (1) from this task's own instructions (an override
// independent of data home): the operator's real auth.json is read once,
// here, and its exact bytes are forwarded to the child via that env var. The
// isolated `XDG_DATA_HOME` still isolates everything else (sessions, its own
// sqlite db, snapshots, logs). Nothing is ever written to disk in the
// isolated dir, so there is no file to chmod 0o600 and no cleanup needed in
// a `finally` or the watchdog kill path (option 2 in the task's own
// preference order is therefore not needed here).

/**
 * Resolves the *operator's real* OpenCode data directory exactly the way
 * OpenCode itself does: `Global.Path.data = path.join(xdgData, "opencode")`
 * (packages/core/src/global.ts:11, `app = "opencode"`), where `xdgData`
 * comes from the `xdg-basedir` npm package OpenCode imports
 * (packages/core/src/global.ts:3): `env.XDG_DATA_HOME || path.join(homedir,
 * '.local', 'share')`. Verified from that package's own source
 * (sindresorhus/xdg-basedir, index.js): this rule is **not** platform
 * branched - it is the same on win32 as everywhere else. `os.homedir()` on
 * Windows resolves to `%USERPROFILE%`, so the unset-XDG_DATA_HOME default
 * there is literally `%USERPROFILE%\.local\share\opencode`, not
 * `%LOCALAPPDATA%\opencode` as a Windows-idiomatic guess might assume (and
 * as this file used to assume - see the removed `LOCALAPPDATA` line this
 * task corrected, docs/adapters.md "opencode: credential forwarding (D1)").
 * `env`/`homedir` are overridable for tests; real callers always get
 * `process.env`/`os.homedir()`.
 */
export function resolveRealOpencodeDataHome({ env = process.env, homedir = os.homedir() } = {}) {
  const xdgDataHome = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
  return path.join(xdgDataHome, 'opencode');
}

/** `<real data home>/auth.json` (packages/opencode/src/auth/index.ts:10). */
export function resolveRealAuthPath(opts) {
  return path.join(resolveRealOpencodeDataHome(opts), 'auth.json');
}

/**
 * Reads the operator's real auth.json (never the isolated per-agent copy)
 * and returns `{ exists, providers, raw }`. `raw` is the exact file text,
 * forwarded verbatim via `OPENCODE_AUTH_CONTENT` so the child reads live
 * credentials without them ever being copied onto disk anywhere under the
 * isolated run directory. `providers` is `Object.keys(...)` of the parsed
 * JSON only - the provider ids auth.json is keyed by - never any token,
 * refresh, or key value; those never leave this function. A file that
 * exists but fails to parse still has its raw text forwarded (OpenCode's own
 * `JSON.parse` will surface whatever error it always would have), just with
 * an empty provider list since none could be enumerated here.
 */
export function loadOperatorAuth({ authPath, readFile = (p) => readFileSync(p, 'utf8'), existsFn = existsSync } = {}) {
  if (!authPath || !existsFn(authPath)) return { exists: false, providers: [], raw: null };
  let raw;
  try {
    raw = readFile(authPath);
  } catch {
    return { exists: false, providers: [], raw: null };
  }
  let providers = [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') providers = Object.keys(parsed);
  } catch {
    providers = [];
  }
  return { exists: true, providers, raw };
}

/**
 * `{ env patch, event }` for forwarding the operator's real OpenCode
 * credentials into an isolated child. When auth.json exists, `env` sets
 * `OPENCODE_AUTH_CONTENT` to its raw text and `event.type` is
 * `credentials.forwarded` with the provider id list (never values). When it
 * does not, `env` is empty (OpenCode's own 401 surfaces exactly as it would
 * for an operator who never ran `opencode auth login`) and `event.type` is
 * `credentials.missing` naming the path that was checked, severity `warn` so
 * a missing auth.json is never silently swallowed.
 */
export function buildCredentialForward({ authEnv, authHomedir, authReadFile, authExistsSync } = {}) {
  const realAuthPath = resolveRealAuthPath({ env: authEnv, homedir: authHomedir });
  const auth = loadOperatorAuth({ authPath: realAuthPath, readFile: authReadFile, existsFn: authExistsSync });
  const ts = new Date().toISOString();
  if (auth.exists) {
    return {
      env: { OPENCODE_AUTH_CONTENT: auth.raw },
      event: { ts, type: 'credentials.forwarded', severity: 'info', providers: auth.providers },
    };
  }
  return {
    env: {},
    event: { ts, type: 'credentials.missing', severity: 'warn', path: realAuthPath },
  };
}

// ---------------------------------------------------------------------------
// D2: agent definition and permission binding
// ---------------------------------------------------------------------------
//
// See docs/adapters.md "opencode: agent definition and permission binding
// (D2)" for the full citation trail. Summary: OpenCode's own agents are
// defined in *its* config, under `agent.<name>` (packages/core/src/v1/
// config/agent.ts), not in this kit's config - the isolated environment
// ships none, so `--agent <name>` always falls back to OpenCode's default
// agent and a reviewer's `read_only`/`permission` block is never bound.
// `OPENCODE_CONFIG_CONTENT` (packages/opencode/src/config/config.ts:482-490)
// injects literal config JSON, bypassing any file or directory entirely -
// the same env-var-content mechanism D1 uses for auth.json - so this adapter
// generates one `{ agent: { <name>: {...} } }` document per launch and sets
// that env var; nothing is written to disk.

const FILE_REF_RE = /^\{file:(.+)\}$/;

/**
 * `community/agents/<x>/config.json`'s own `prompt` field convention -
 * `"{file:./prompts/reviewer.md}"` - is this kit's own convention (docs/
 * community.md does not define where it resolves from), not OpenCode's
 * `{file:...}` config substitution (which resolves relative to the config
 * file itself - packages/opencode/src/config/variable.ts - and is never
 * reached here, since this function reads the prompt text itself rather than
 * emitting the token for OpenCode to substitute). The shipped templates
 * (community/agents/{blind-reviewer,novice-builder}/config.json) have no
 * local `prompts/` directory of their own, so the only files their relative
 * paths can mean are this repo's own top-level `prompts/*.md` - resolved
 * here against `repoRoot` (defaulting to this module's own package root),
 * not against the template file's own directory. OPEN QUESTION flagged in
 * the wave log: a future community template outside this repo would need
 * its own resolution rule.
 */
export function resolvePromptField(promptField, { readFile = (p) => readFileSync(p, 'utf8'), repoRoot = REPO_ROOT, templatePath } = {}) {
  if (typeof promptField !== 'string') return undefined;
  const m = promptField.match(FILE_REF_RE);
  if (!m) return promptField;
  const relPath = m[1];
  const resolved = path.isAbsolute(relPath) ? relPath : path.join(repoRoot, relPath);
  try {
    return readFile(resolved);
  } catch (e) {
    const err = new Error(
      `opencode agent template prompt file not found: ${resolved}${templatePath ? ` (from ${templatePath})` : ''}`
    );
    err.code = 1;
    throw err;
  }
}

/**
 * `true` when `permission` (OpenCode's own bare-Action-or-object shape, per
 * `packages/core/src/v1/config/permission.ts`) denies `edit` by default.
 * `edit` is a `Rule` (`Action | Record<string, Action>`, same file): its own
 * value can be the bare string `"deny"`, or a glob-pattern-to-action *object*
 * whose `"*"` entry is `"deny"` - the same default-deny-plus-narrow-allowlist
 * shape this template already used for `bash` before this change, now also
 * used for `edit` so exactly a "verdict.json at any depth" glob can be
 * allowed while every other path stays denied (docs/review-protocol.md
 * "PR triage mode"; see
 * docs/adapters.md "opencode: edit permission is per-path, not per-tool
 * (V1)" for the full citation trail, including why a narrow allow entry
 * elsewhere in the object does not make this return `false` - OpenCode's own
 * `Permission.evaluate`, `packages/opencode/src/permission/index.ts`, is
 * `rulesets.flat().findLast(...)`: the *last* matching rule wins, so a
 * specific override placed after the wildcard in the object is what makes it
 * win for that one path while every other path still hits the wildcard
 * `"deny"` first). No `"*"` entry in the object at all means this cannot
 * confirm a deny-by-default stance, so it falls through instead of guessing.
 * When there is no `edit` key, falls back to the whole permission block's own
 * wildcard `"*"` (unchanged from before this task), or the bare string form.
 */
function permissionDeniesEdit(permission) {
  if (permission == null) return false;
  if (typeof permission === 'string') return permission === 'deny';
  const edit = permission.edit;
  if (typeof edit === 'string') return edit === 'deny';
  if (edit && typeof edit === 'object') {
    return typeof edit['*'] === 'string' && edit['*'] === 'deny';
  }
  if (typeof permission['*'] === 'string') return permission['*'] === 'deny';
  return false;
}

/**
 * Translates a `community/agents/<x>/config.json`-shaped object into
 * OpenCode's `agent.<name>` schema (packages/core/src/v1/config/agent.ts:
 * `model`, `variant`, `temperature`, `top_p`, `prompt`, `mode`, `permission`
 * - packages/core/src/v1/config/permission.ts for `permission`'s own shape).
 * `mode: "primary"` is always set explicitly (a custom top-level
 * `config.agent.<name>` entry with no `mode` defaults to `"all"` per
 * packages/opencode/src/agent/agent.ts:276, which also satisfies `--agent`'s
 * `mode !== "subagent"` gate - but `"primary"` is unambiguous and matches
 * this kit's own convention for an agent invoked directly, never as a
 * subagent). `permission` is carried over byte-for-byte from the community
 * config's own `permission` object (already written in OpenCode's exact
 * schema shape - see community/agents/blind-reviewer/config.json); when
 * there is no `permission` block but `read_only: true` is asserted, a
 * conservative deny-everything-but-inspect block is synthesized instead of
 * silently launching unrestricted.
 */
export function translateCommunityAgentConfig({ community, model, templatePath, readFile, repoRoot } = {}) {
  const out = { mode: 'primary' };
  const resolvedModel = model || community.model;
  if (resolvedModel) out.model = resolvedModel;
  if (typeof community.temperature === 'number') out.temperature = community.temperature;
  if (typeof community.top_p === 'number') out.top_p = community.top_p;
  const prompt = resolvePromptField(community.prompt, { readFile, repoRoot, templatePath });
  if (prompt !== undefined) out.prompt = prompt;
  if (community.permission && typeof community.permission === 'object') {
    out.permission = community.permission;
  } else if (community.read_only === true) {
    out.permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' };
  }
  return out;
}

/**
 * Resolves the OpenCode `agent.<name>` definition for one launch, in the
 * precedence this task's own instructions give:
 *   1. `agentDef.opencode` - a raw OpenCode-shaped object, used verbatim
 *      (the resolved `model` still fills in when the block omits one).
 *   2. `agentDef.template` - a path to a community/agents/<x>/config.json
 *      style file (read as-is, same convention as `--prompt-file`: resolved
 *      by Node against the process cwd when relative), translated via
 *      `translateCommunityAgentConfig`.
 *   3. Neither: a minimal `{ model }` only - OpenCode's own default
 *      permission set applies, unrestricted. Still enough on its own to fix
 *      D2's "not found" fallback (any `agent.<name>` entry, however small,
 *      makes OpenCode's own agent lookup succeed).
 * Throws Error(.code=1) when `agentDef.read_only` is `true` but the
 * resulting permission does not actually deny `edit` - docs/security.md's
 * "Permissions at the harness layer" already promises "the adapters refuse
 * to launch a reviewer with write permissions when the config says
 * read_only: true"; this is where that promise is kept for OpenCode.
 */
export function buildOpencodeAgentDefinition({ agentDef = {}, agentName, model, readFile, repoRoot } = {}) {
  let definition;
  if (agentDef.opencode && typeof agentDef.opencode === 'object') {
    definition = { ...(model ? { model } : {}), ...agentDef.opencode };
  } else if (agentDef.template) {
    let raw;
    try {
      raw = (readFile ?? ((p) => readFileSync(p, 'utf8')))(agentDef.template);
    } catch (e) {
      const err = new Error(`opencode agent template not found: ${agentDef.template}`);
      err.code = 1;
      throw err;
    }
    let community;
    try {
      community = JSON.parse(raw);
    } catch (e) {
      const err = new Error(`opencode agent template is not valid JSON: ${agentDef.template}`);
      err.code = 1;
      throw err;
    }
    definition = translateCommunityAgentConfig({ community, model, templatePath: agentDef.template, readFile, repoRoot });
  } else {
    definition = model ? { model } : {};
  }

  if (agentDef.read_only === true && !permissionDeniesEdit(definition.permission)) {
    const err = new Error(
      `opencode agent "${agentName ?? ''}" is marked read_only but resolves to a permission block that does not deny edit - refusing to launch a reviewer with write permissions (docs/security.md "Permissions at the harness layer")`
    );
    err.code = 1;
    throw err;
  }

  return definition;
}

/**
 * buildArgv({ prompt, cwd, agent, model, dataHome, outDir, auth, cmd,
 * argsPrefix, toolOverride }) -> { cmd, args, cwd, env, resolvedFrom,
 * credentialsEvent }. `dataHome` is joined with `agent` to isolate each
 * agent's OpenCode data directory (docs/adapters.md "Concurrency note": two
 * OpenCode processes sharing one data directory have deadlocked on
 * OpenCode's own database), exported as `XDG_DATA_HOME` (Windows uses this
 * exact same variable too - see resolveRealOpencodeDataHome's doc comment
 * above; OpenCode never consults `LOCALAPPDATA`) per this
 * wave's task card. `outDir` (not part of the task card's literal buildArgv
 * signature, but required to compute it - see this executor's final report)
 * sets `CORTEX_EVENTS_PATH` to `<outDir>/events.jsonl` for the plugin.
 * `rejectAnthropicModel` runs before anything else: Anthropic subscription
 * OAuth may not be used inside a third party harness.
 *
 * Command resolution (docs/adapters.md "Windows command resolution"), in
 * precedence order: an explicit `cmd` (review round 1, F2 test harness -
 * `config.adapters.opencode.cmd`/`argsPrefix` stand a stub binary in for the
 * real CLI in tests) wins outright; then `toolOverride`
 * (`config.tools.opencode`, an operator-supplied argv array that skips
 * resolution entirely); then `resolveCommand('opencode', ...)`, which on
 * win32 finds the real target behind an npm `opencode.cmd` shim (the
 * reference Windows machine's `opencode.cmd` is the direct-exe shape:
 * `cmd` becomes the real `.../opencode-ai/bin/opencode.exe`) and on every
 * other platform is `cmd: 'opencode'` unchanged. `platformOverride` lets
 * tests inject `'win32'` for command resolution without needing to fake
 * `node:process`'s own platform.
 *
 * D1/D2 params (both no-ops when the field they need is absent):
 * `agentDef` is this kit's own `config.agents[<agent>]` object (or `{}`) -
 * consulted only for `.opencode`/`.template`/`.read_only` (see
 * `buildOpencodeAgentDefinition`); `authEnv`/`authHomedir`/`authReadFile`/
 * `authExistsSync` override the operator's real environment/homedir/fs for
 * credential-forwarding tests (see `buildCredentialForward`); `repoRoot`
 * overrides where a community template's `{file:...}` prompt reference
 * resolves from (see `resolvePromptField`). `readFile` is shared with
 * command resolution above (both want the same `(path) -> text` shape).
 */
export function buildArgv({
  prompt, cwd, agent, model, dataHome, outDir, auth,
  cmd, argsPrefix, toolOverride, platformOverride, env: envOverride, execPath, readFile,
  agentDef = {}, authEnv, authHomedir, authReadFile, authExistsSync, repoRoot,
}) {
  rejectAnthropicModel(model);

  const env = filterEnv(process.env, { adapter: 'opencode', auth });
  let credentialsEvent = null;
  if (dataHome) {
    const agentDataDir = path.join(dataHome, agent || 'default');
    env.XDG_DATA_HOME = agentDataDir;

    // D1: the isolation above means this run's OpenCode process cannot see
    // the operator's real auth.json (it lives inside the same data dir this
    // just isolated away) - forward it independently. See the module-level
    // "D1: credential forwarding into the isolated data dir" comment.
    const forward = buildCredentialForward({ authEnv, authHomedir, authReadFile, authExistsSync });
    Object.assign(env, forward.env);
    credentialsEvent = forward.event;
  }
  if (outDir) {
    env.CORTEX_EVENTS_PATH = path.join(outDir, 'events.jsonl');
  }

  // D2: define exactly one OpenCode agent named `agent`, so `--agent
  // <name>` resolves instead of silently falling back to OpenCode's default
  // agent and losing whatever permission block a reviewer needed bound. See
  // the module-level "D2: agent definition and permission binding" comment.
  // Skipped entirely when this launch passes no --agent at all.
  if (agent) {
    const definition = buildOpencodeAgentDefinition({ agentDef, agentName: agent, model, readFile, repoRoot });
    if (Object.keys(definition).length > 0) {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ agent: { [agent]: definition } });
    }
  }

  const resolution = resolveConfiguredCommand('opencode', {
    cmd,
    toolOverride,
    platform: platformOverride,
    env: envOverride,
    execPath,
    readFile,
  });
  // Blocker 1 (src/adapters/prompt-delivery.mjs): OpenCode's own
  // `resolveRunInput(message, piped)` (packages/opencode/src/cli/cmd/run.ts)
  // returns the piped stdin text whenever the positional `message` is empty
  // - so a large prompt is simply never appended as the trailing positional
  // here, and `opencode run` reads it from stdin instead. See
  // docs/adapters.md "Prompt delivery (Blocker 1)" for the exact source
  // lines this was verified against.
  const delivery = choosePromptDelivery(prompt);
  const ownArgs = [
    'run',
    ...(agent ? ['--agent', agent] : []),
    ...(model ? ['--model', model] : []),
    '--format', 'json',
    ...(delivery === 'argv' ? [prompt] : []),
  ];
  const built = applyResolvedCommand(resolution, [...(argsPrefix ?? []), ...ownArgs]);

  return {
    cmd: built.cmd,
    args: built.args,
    cwd,
    env,
    resolvedFrom: resolution.resolvedFrom,
    credentialsEvent,
    promptDelivery: delivery,
    stdin: delivery === 'stdin' ? prompt : undefined,
    promptDeliveryEvent: promptDeliveryEvent(delivery, prompt),
  };
}

/**
 * `part.state.time.{start,end}` (both epoch ms, when present - a real
 * capture, test/fixtures/opencode-run.real.jsonl, has this nested under
 * `state` alongside `status`/`input`/`output`, not as a sibling of `state`)
 * -> integer ms, or `null` when either bound is missing (per this task's own
 * instruction: "ms derived from part.time.start/end if present else null" -
 * `time` is read off `part.state` here since that is where OpenCode 1.18.27
 * actually places it).
 */
function toolMs(part) {
  const time = part?.state?.time;
  if (time && typeof time.start === 'number' && typeof time.end === 'number') {
    return time.end - time.start;
  }
  return null;
}

/**
 * createStreamParser() -> { push(line) -> events[], flush() -> events[] }
 * (review round 1, F2; rewritten for E2-3 to handle the *real*
 * `opencode run --format json` stream, not only already-normalized events).
 * Two input shapes are handled:
 *
 * 1. A line that already carries a recognized normalized `type` (this is
 *    what the plugin's events.jsonl - and the pre-existing
 *    `opencode-events.jsonl` fixture - looks like) is passed through, but
 *    its free text fields are re-redacted and re-capped rather than trusted
 *    blindly. This path is untouched by this task.
 *
 * 2. OpenCode's own raw `run --format json` stdout (docs/adapters.md
 *    "opencode: parsing the real run --format json stream", cites
 *    packages/opencode/src/session/message-v2.ts and
 *    packages/opencode/src/cli/cmd/run.ts; real capture in
 *    test/fixtures/opencode-run.real.jsonl):
 *      - the *first* raw line carrying a top-level `sessionID` (`step_start`
 *        in the real capture, but this is deliberately type-agnostic -
 *        `tool_use`/`step_finish`/`text`/`error` all carry the same field)
 *        emits exactly one `session.start`; every later line's `sessionID`
 *        is dedup'd against it and never emits a second one.
 *      - `tool_use` with `part.state.status` `"completed"` or `"error"`
 *        emits both `tool.call` and `tool.result` (OpenCode's JSON mode
 *        reports a tool call already resolved, never as two separate
 *        before/after lines the way the plugin does) - `ok` follows the
 *        status, `ms` from `part.state.time.start/end`, and (mirroring how
 *        claude.mjs's `tool_result` translation works: no input/output body
 *        ever leaves this function, only a capped+redacted summary) an
 *        `error` field on the result only when `ok` is false. Any other
 *        `state.status` (still in progress) is skipped, not counted as
 *        unparsed.
 *      - `step_finish` -> a `message` event (the same normalized type
 *        claude.mjs and codex.mjs already use for turn/step usage) carrying
 *        `part.tokens.{input,output,reasoning,cache.read,cache.write}` and
 *        `cost_usd` from `part.cost` - `0` is a real reported value (a free
 *        or subscription lane), recorded as `0` with `usage_source:
 *        'reported'`, never coerced to null or skipped. Running totals feed
 *        the synthesized `session.end` below.
 *      - `text` carries the assistant's final answer but no usage of its
 *        own; docs/adapters.md's vocabulary has no plain-text assistant
 *        event, so it is skipped with no event and no unparsed-line count
 *        (this is a known, expected shape, not a hole in this parser).
 *      - `error` (a real top-level `{"type":"error",...}` line - a 410 Gone
 *        for an EOL model and a 401 Unauthorized are the two observed
 *        shapes) emits a normalized `error` event, `severity: 'halt'`,
 *        `status_code`/`retryable`/`message` read from
 *        `error.data.{statusCode,isRetryable,message}` (falling back to
 *        `error.{statusCode,isRetryable,message}` - OpenCode's own
 *        harness-level classification, used as-is), message
 *        capped+redacted. This event is informational only: it never sets
 *        an exit code anywhere - the spawned process's own real exit code
 *        stays authoritative (see `run()` below and docs/adapters.md).
 *      - any other top-level `type` (a raw shape this parser does not yet
 *        know) is ignored, but counted - see `unparsed_lines` below - so a
 *        format change upstream is visible in the ledger instead of
 *        silently swallowed.
 *      - `flush()` synthesizes exactly one `session.end` for this raw-stream
 *        case (never when a normalized `session.end` already passed
 *        through - the plugin/already-normalized path keeps behaving
 *        exactly as before), carrying `session_id`, the running
 *        `tokens_in`/`tokens_out`/`cost_usd` totals summed across every
 *        `step_finish` seen, `requests` (the `step_finish` count),
 *        `unparsed_lines`, and `exit_code`/`elapsed_ms` both `null` - this
 *        stream never reports either, so `run()` below patches them from
 *        the real spawned process afterward (mirroring codex.mjs's own
 *        `endEvent.exit_code === undefined` patch), and a caller that only
 *        has the raw batch (no process to patch from - e.g. a unit test
 *        parsing the fixture directly) sees `null`, not a fabricated 0.
 *
 * D2's own fallback warning (`agent "x" not found. Falling back to default
 * agent`, plain text, never JSON) keeps working exactly as before - it is
 * matched in the `JSON.parse` catch branch, ahead of anything above.
 */
export function createStreamParser({ cwd } = {}) {
  let sessionId = null;
  let sessionEmitted = false;
  let sawNormalizedSessionEnd = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let stepFinishCount = 0;
  let unparsedLines = 0;
  let flushed = false;

  function maybeSessionStart(obj) {
    const sid = obj.sessionID ?? obj.sessionId ?? null;
    if (!sid) return [];
    if (!sessionId) sessionId = sid;
    if (sessionEmitted) return [];
    sessionEmitted = true;
    return [{ ts: new Date().toISOString(), type: 'session.start', session_id: sid }];
  }

  function pushLine(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      const notFound = text.match(AGENT_NOT_FOUND_RE);
      if (notFound) {
        return [
          {
            ts: new Date().toISOString(),
            type: 'agent.fallback',
            severity: 'warn',
            agent: notFound[1],
            reason: 'not_found',
            detail: capText(text),
          },
        ];
      }
      const subagent = text.match(AGENT_SUBAGENT_RE);
      if (subagent) {
        return [
          {
            ts: new Date().toISOString(),
            type: 'agent.fallback',
            severity: 'warn',
            agent: subagent[1],
            reason: 'subagent',
            detail: capText(text),
          },
        ];
      }
      return [];
    }

    if (NORMALIZED_TYPES.has(obj.type)) {
      const event = { ...obj };
      if (typeof event.args_summary === 'string') event.args_summary = capText(event.args_summary, cwd);
      if (typeof event.error === 'string') event.error = capText(event.error, cwd);
      if (typeof event.message === 'string') event.message = capText(event.message, cwd);
      if (event.type === 'session.end') sawNormalizedSessionEnd = true;
      return [event];
    }

    if (!RAW_STREAM_TYPES.has(obj.type)) {
      unparsedLines++;
      return [];
    }

    const events = maybeSessionStart(obj);
    const ts = new Date().toISOString();

    switch (obj.type) {
      case 'step_start':
      case 'text':
        // step_start only carries the session id (handled above); text
        // carries the assistant's answer but no usage of its own - neither
        // has a normalized event of its own (see the doc comment above).
        break;

      case 'tool_use': {
        const part = obj.part ?? {};
        const status = part.state?.status;
        if (status === 'completed' || status === 'error') {
          const ok = status === 'completed';
          events.push({
            ts,
            type: 'tool.call',
            tool: part.tool ?? null,
            call_id: part.callID ?? null,
            args_summary: capText(part.state?.input ?? {}, cwd),
          });
          const resultEvent = { ts, type: 'tool.result', tool: part.tool ?? null, call_id: part.callID ?? null, ok, ms: toolMs(part) };
          if (!ok) resultEvent.error = capText(part.state?.error ?? part.state?.output ?? '', cwd);
          events.push(resultEvent);
        }
        // Any other status (still running) is a known, expected shape for
        // an in-flight tool call - not counted as unparsed.
        break;
      }

      case 'step_finish': {
        const part = obj.part ?? {};
        const tokens = part.tokens ?? {};
        const tokensInVal = tokens.input ?? 0;
        const tokensOutVal = tokens.output ?? 0;
        const cost = typeof part.cost === 'number' ? part.cost : 0;
        tokensIn += tokensInVal;
        tokensOut += tokensOutVal;
        costUsd += cost;
        stepFinishCount++;
        events.push({
          ts,
          type: 'message',
          role: 'assistant',
          session_id: sessionId,
          tokens_in: tokensInVal,
          tokens_out: tokensOutVal,
          tokens_reasoning: tokens.reasoning ?? 0,
          cache_read: tokens.cache?.read ?? 0,
          cache_write: tokens.cache?.write ?? 0,
          cost_usd: cost,
          usage_source: 'reported',
        });
        break;
      }

      case 'error': {
        // Phase 1a real-batch fix F1 (the real evidence this fix is built
        // from: 12 of 16 runs in the live batch failed on exactly this
        // shape, a 429 "Too Many Requests" from nvidia's API). `status_code`
        // (snake_case, matching every other field in this kit's normalized
        // event vocabulary - `statusCode` was the one camelCase outlier)
        // and `retryable` are read directly off OpenCode's own
        // `error.data.{statusCode,isRetryable}` (falling back to
        // `error.{statusCode,isRetryable}`) - OpenCode's own harness-level
        // classification, used as-is, not re-derived from a status
        // whitelist the way claude.mjs/codex.mjs must (see
        // src/adapters/error-event.mjs's doc comment: those two harnesses
        // report no such flag at all).
        const err = obj.error ?? {};
        const data = err.data ?? {};
        const statusCode = data.statusCode ?? err.statusCode ?? null;
        const retryable = data.isRetryable === true || err.isRetryable === true;
        events.push({
          ts,
          type: 'error',
          severity: 'halt',
          name: err.name ?? null,
          status_code: statusCode,
          retryable,
          message: capText(data.message ?? err.message ?? '', cwd),
        });
        break;
      }

      default:
        break;
    }

    return events;
  }

  return {
    push: pushLine,
    flush() {
      if (flushed) return [];
      flushed = true;
      // Only the raw-stream case needs a synthesized session.end - a
      // stream that already carried a normalized one (the plugin/
      // already-normalized-fixture path) must not get a second one.
      if (!sessionEmitted || sawNormalizedSessionEnd) return [];
      return [
        {
          ts: new Date().toISOString(),
          type: 'session.end',
          session_id: sessionId,
          exit_code: null,
          elapsed_ms: null,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: costUsd,
          requests: stepFinishCount,
          unparsed_lines: unparsedLines,
        },
      ];
    },
  };
}

/**
 * parseStream(lines, { cwd }) -> normalized events, batch form. A thin
 * wrapper over createStreamParser() kept for the existing unit tests (and
 * run()'s own non-detached path below) - see createStreamParser()'s doc
 * comment for the translation rules. `cwd`, when given, is forwarded
 * straight through so a tool's `args_summary` never leaks the run's own
 * absolute worktree path (see `capText`/`relativizeToCwd`); omitted, every
 * existing caller (every unit test included) behaves exactly as before.
 */
export function parseStream(lines, { cwd } = {}) {
  const parser = createStreamParser({ cwd });
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const events = [];
  for (const raw of list) events.push(...parser.push(raw));
  events.push(...parser.flush());
  return events;
}

/** run(opts) per the interface at the top of docs/adapters.md. */
export async function run(opts) {
  const { prompt, cwd, agent, model, dataHome, outDir, auth, timeoutMs, detach, onEvent, agentDef } = opts;
  const { cmd, args, env, credentialsEvent, stdin: stdinText, promptDelivery, promptDeliveryEvent: pdEvent } = buildArgv({
    prompt, cwd, agent, model, dataHome, outDir, auth, agentDef,
  });

  // D1/D2 bookkeeping (credentials.forwarded/missing, from buildArgv above)
  // plus Blocker 1's own prompt.delivery event: fired as soon as each is
  // known, same as every other event this adapter reports live via onEvent,
  // and folded into whatever this run's own events.jsonl ends up containing
  // below (the `--sync` path never runs through runner.mjs's own
  // event-seeding, so it must happen here instead).
  const earlyEvents = [credentialsEvent, pdEvent].filter(Boolean);
  for (const event of earlyEvents) onEvent?.(event);

  mkdirSync(outDir, { recursive: true });
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: [stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
  });
  writeFileSync(path.join(outDir, 'pid.txt'), String(child.pid ?? ''));
  if (stdinText !== undefined) {
    child.stdin.write(stdinText);
    child.stdin.end();
  }

  if (detach) {
    child.unref();
    return { pid: child.pid };
  }

  const start = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, timeoutMs)
    : null;

  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const exitCode = normalizeExitCode(
    await new Promise((resolve) => {
      child.on('close', (code) => resolve(timedOut ? 137 : code ?? 1));
      child.on('error', () => resolve(1));
    })
  );
  if (timer) clearTimeout(timer);
  const elapsedMs = Date.now() - start;

  const parsedEvents = parseStream(stdout.split('\n'), { cwd });
  // The raw-stream `session.end` createStreamParser() synthesizes in
  // flush() reports `exit_code`/`elapsed_ms` as `null` - that stream never
  // carries either - patched here from the real spawned process, the same
  // pattern codex.mjs uses for its own NDJSON session.end (docs/adapters.md
  // "keep the run's exit code authoritative": a 410/401 `error` event never
  // sets this itself). Never touches an already-normalized session.end from
  // a fixture/plugin path, which already carries its own real value.
  const ownEndEvent = [...parsedEvents].reverse().find((e) => e.type === 'session.end');
  if (ownEndEvent && (ownEndEvent.exit_code === null || ownEndEvent.exit_code === undefined)) ownEndEvent.exit_code = exitCode;
  if (ownEndEvent && (ownEndEvent.elapsed_ms === null || ownEndEvent.elapsed_ms === undefined)) ownEndEvent.elapsed_ms = elapsedMs;
  for (const event of parsedEvents) onEvent?.(event);
  const ownEvents = [...earlyEvents, ...parsedEvents];

  // The plugin (plugins/opencode/cortex-ledger.js) is authoritative: never
  // overwrite its events.jsonl with this adapter's best-effort parse. Only
  // write our own fallback when the plugin's file never appeared.
  const pluginEventsPath = env.CORTEX_EVENTS_PATH;
  const pluginWroteEvents = Boolean(pluginEventsPath) && existsSync(pluginEventsPath);
  if (!pluginWroteEvents) {
    const outPath = path.join(outDir, 'events.jsonl');
    writeFileSync(outPath, ownEvents.map((e) => JSON.stringify(e)).join('\n') + (ownEvents.length ? '\n' : ''));
  }

  writeFileSync(path.join(outDir, 'out.txt'), redact(stdout || stderr));
  writeFileSync(path.join(outDir, 'exit.txt'), String(exitCode));
  writeFileSync(path.join(outDir, 'elapsed_ms.txt'), String(elapsedMs));
  writeFileSync(path.join(outDir, 'done.marker'), '');

  let finalEvents = ownEvents;
  if (pluginWroteEvents) {
    try {
      finalEvents = parseStream(readFileSync(pluginEventsPath, 'utf8').split('\n'));
    } catch {
      finalEvents = ownEvents;
    }
  }

  const endEvent = [...finalEvents].reverse().find((e) => e.type === 'session.end');
  const toolCalls = finalEvents.filter((e) => e.type === 'tool.call').length;

  return {
    pid: child.pid,
    exitCode,
    sessionId: endEvent?.session_id ?? null,
    tokensIn: endEvent?.tokens_in ?? 0,
    tokensOut: endEvent?.tokens_out ?? 0,
    costUsd: endEvent?.cost_usd ?? 0,
    requests: endEvent?.requests ?? 0,
    toolCalls,
    summary: '',
    promptDelivery,
  };
}
