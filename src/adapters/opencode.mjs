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
import { filterEnv, rejectAnthropicModel, redact } from './credential-boundary.mjs';
import { applyResolvedCommand, resolveConfiguredCommand } from './resolve-command.mjs';

const ARGS_SUMMARY_MAX = 200;
const NORMALIZED_TYPES = new Set(['session.start', 'tool.call', 'tool.result', 'message', 'session.end']);

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

function capText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
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

/** `true` when `permission` (OpenCode's own bare-Action-or-object shape) denies `edit` outright - either an object's own `edit` rule is `"deny"`, or (no `edit` key) its wildcard `"*"` is `"deny"`, or the whole permission value is the bare string `"deny"`. */
function permissionDeniesEdit(permission) {
  if (permission == null) return false;
  if (typeof permission === 'string') return permission === 'deny';
  if (typeof permission.edit === 'string') return permission.edit === 'deny';
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
  const ownArgs = [
    'run',
    ...(agent ? ['--agent', agent] : []),
    ...(model ? ['--model', model] : []),
    '--format', 'json', prompt,
  ];
  const built = applyResolvedCommand(resolution, [...(argsPrefix ?? []), ...ownArgs]);

  return {
    cmd: built.cmd,
    args: built.args,
    cwd,
    env,
    resolvedFrom: resolution.resolvedFrom,
    credentialsEvent,
  };
}

/**
 * createStreamParser() -> { push(line) -> events[], flush() -> events[] }
 * (review round 1, F2), best effort (docs/adapters.md "opencode") and
 * genuinely stateless per line - unlike claude's/codex's parsers this one
 * needs no closure state at all, so `push` is the same pure function either
 * way and `flush()` never has anything to add. A line that already carries a
 * recognized normalized `type` (this is what the plugin's events.jsonl - and
 * this fixture format - looks like) is passed through, but its free text
 * fields are re-redacted and re-capped rather than trusted blindly. Anything
 * else is treated as OpenCode's own raw `run --format json` stdout and
 * translated on a best-effort basis; that stream is not authoritative (see
 * the module comment above), so unrecognized shapes are simply skipped -
 * except D2's own fallback warning (`agent "x" not found. Falling back to
 * default agent`, plain text, never JSON), which is turned into an
 * `agent.fallback` event, severity `warn`, so a silent permission downgrade
 * is never silent again.
 */
export function createStreamParser() {
  return {
    push(raw) {
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
        if (typeof event.args_summary === 'string') event.args_summary = capText(event.args_summary);
        if (typeof event.error === 'string') event.error = capText(event.error);
        return [event];
      }

      const sessionId = obj.sessionID ?? obj.sessionId ?? null;
      if (sessionId) {
        return [{ ts: new Date().toISOString(), type: 'session.start', session_id: sessionId }];
      }
      return [];
    },
    flush() {
      return [];
    },
  };
}

/**
 * parseStream(lines) -> normalized events, batch form. A thin wrapper over
 * createStreamParser() kept for the existing unit tests (and run()'s own
 * non-detached path below) - see createStreamParser()'s doc comment for the
 * translation rules.
 */
export function parseStream(lines) {
  const parser = createStreamParser();
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const events = [];
  for (const raw of list) events.push(...parser.push(raw));
  events.push(...parser.flush());
  return events;
}

/** run(opts) per the interface at the top of docs/adapters.md. */
export async function run(opts) {
  const { prompt, cwd, agent, model, dataHome, outDir, auth, timeoutMs, detach, onEvent, agentDef } = opts;
  const { cmd, args, env, credentialsEvent } = buildArgv({ prompt, cwd, agent, model, dataHome, outDir, auth, agentDef });

  // D1/D2 bookkeeping (credentials.forwarded/missing, from buildArgv above):
  // fired as soon as it is known, same as every other event this adapter
  // reports live via onEvent, and folded into whatever this run's own
  // events.jsonl ends up containing below (the `--sync` path never runs
  // through runner.mjs's own event-seeding, so it must happen here instead).
  const earlyEvents = credentialsEvent ? [credentialsEvent] : [];
  for (const event of earlyEvents) onEvent?.(event);

  mkdirSync(outDir, { recursive: true });
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  writeFileSync(path.join(outDir, 'pid.txt'), String(child.pid ?? ''));

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

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(timedOut ? 137 : code ?? 1));
    child.on('error', () => resolve(1));
  });
  if (timer) clearTimeout(timer);
  const elapsedMs = Date.now() - start;

  const parsedEvents = parseStream(stdout.split('\n'));
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
  };
}
