// docs/adapters.md "codex (Codex CLI)". Same interface as every adapter:
// buildArgv, parseStream, run(opts).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterEnv, redact, relativizeToCwd } from './credential-boundary.mjs';
import { applyResolvedCommand, resolveConfiguredCommand } from './resolve-command.mjs';
import { normalizeExitCode } from '../exit-code.mjs';
import { firstStatusCode, retryableFromStatus } from './error-event.mjs';
import { choosePromptDelivery, promptDeliveryEvent } from './prompt-delivery.mjs';

const ARGS_SUMMARY_MAX = 200;
const TOOL_ITEM_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call']);

/**
 * `cwd`, when given, relativizes any string in `value` equal to or starting
 * with it (`relativizeToCwd`, `src/adapters/credential-boundary.mjs`)
 * before redaction/capping - a `command_execution`/`file_change` item's own
 * `command`/`path` is frequently the run's absolute worktree path or a path
 * under it, which must never reach `args_summary`/`error` on disk verbatim
 * (see CHANGELOG.md "tool args relative to cwd").
 */
function capSummary(value, cwd) {
  const relativized = cwd ? relativizeToCwd(value, cwd) : value;
  const text = typeof relativized === 'string' ? relativized : JSON.stringify(relativized ?? {});
  const safe = redact(text);
  return safe.length > ARGS_SUMMARY_MAX ? safe.slice(0, ARGS_SUMMARY_MAX) : safe;
}

/**
 * buildArgv({ prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth,
 * cmd, argsPrefix, toolOverride }) per docs/adapters.md: stdin is always
 * closed by run() (an open stdin hangs the process); `--sandbox` defaults to
 * `read-only` for reviewer roles (`readOnly: true`) and `workspace-write`
 * otherwise; `danger-full-access` is refused outright, whether it arrived as
 * an explicit `sandbox` or as a default (there is no default that resolves
 * to it). A resumed thread never accepts `--sandbox` (Codex would otherwise
 * inherit `~/.codex/config.toml`), so it force-sets
 * `-c sandbox_mode="read-only"` instead.
 *
 * Command resolution (docs/adapters.md "Windows command resolution"), in
 * precedence order: an explicit `cmd` (review round 1, F2 test harness -
 * `config.adapters.codex.cmd`/`argsPrefix` stand a stub binary in for the
 * real CLI in tests) wins outright; then `toolOverride` (`config.tools.codex`,
 * an operator-supplied argv array that skips resolution entirely); then
 * `resolveCommand('codex', ...)`, which on win32 finds the real target
 * behind an npm `codex.cmd` shim (the reference Windows machine's `codex.cmd`
 * is the node-launcher shape: `cmd: execPath`, args prefixed with the real
 * `.../@openai/codex/bin/codex.js`) and on every other platform is
 * `cmd: 'codex'` unchanged.
 */
export function buildArgv({ prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth, cmd, argsPrefix, toolOverride, platform, env, execPath, readFile }) {
  const lastMessagePath = join(outDir, 'last-message.md');
  const resolution = resolveConfiguredCommand('codex', { cmd, toolOverride, platform, env, execPath, readFile });
  const delivery = choosePromptDelivery(prompt);
  const pdEvent = promptDeliveryEvent(delivery, prompt);

  if (resumeThreadId) {
    // Blocker 1 (src/adapters/prompt-delivery.mjs): `codex exec resume`
    // reads stdin only when the positional PROMPT is the literal `-`
    // (codex-rs/exec/src/cli.rs's ResumeArgs `prompt` field doc comment) -
    // unlike plain `exec`, omitting the argument entirely does not trigger
    // it, so a large prompt is never simply dropped here.
    const ownArgs = [
      'exec', 'resume', resumeThreadId, '-c', 'sandbox_mode="read-only"', '--json', '-o', lastMessagePath,
      delivery === 'argv' ? prompt : '-',
    ];
    const built = applyResolvedCommand(resolution, [...(argsPrefix ?? []), ...ownArgs]);
    return {
      cmd: built.cmd,
      args: built.args,
      cwd,
      env: filterEnv(process.env, { adapter: 'codex', auth }),
      resolvedFrom: resolution.resolvedFrom,
      promptDelivery: delivery,
      stdin: delivery === 'stdin' ? prompt : undefined,
      promptDeliveryEvent: pdEvent,
    };
  }

  const chosenSandbox = sandbox ?? (readOnly ? 'read-only' : 'workspace-write');
  if (chosenSandbox === 'danger-full-access') {
    const err = new Error('codex sandbox refused: danger-full-access is never permitted by this kit');
    err.code = 1;
    throw err;
  }

  // Blocker 1: `codex exec`'s own PROMPT positional is documented as "if not
  // provided as an argument ..., instructions are read from stdin"
  // (codex-rs/exec/src/cli.rs) - omitting it entirely (rather than passing
  // `-`) is enough here, unlike the resume case above.
  const ownArgs = [
    'exec', '--json', '--sandbox', chosenSandbox, '--cd', cwd, '-o', lastMessagePath,
    ...(delivery === 'argv' ? [prompt] : []),
  ];
  const built = applyResolvedCommand(resolution, [...(argsPrefix ?? []), ...ownArgs]);
  return {
    cmd: built.cmd,
    args: built.args,
    cwd,
    env: filterEnv(process.env, { adapter: 'codex', auth }),
    resolvedFrom: resolution.resolvedFrom,
    promptDelivery: delivery,
    stdin: delivery === 'stdin' ? prompt : undefined,
    promptDeliveryEvent: pdEvent,
  };
}

/**
 * createStreamParser() -> { push(line) -> events[], flush() -> events[] }
 * (review round 1, F2), the incremental form of Codex's `exec --json` NDJSON
 * translation (docs/adapters.md: "Parse the NDJSON for `thread.started`
 * (session id), item events (tool calls), and `turn.completed` usage when
 * present"), driven one raw stdout line at a time by
 * src/adapters/runner.mjs.
 *
 * - `thread.started` -> `session.start`.
 * - `item.started` / `item.completed` on a tool-shaped item
 *   (`command_execution`, `file_change`, `mcp_tool_call`) -> `tool.call` /
 *   `tool.result`.
 * - `turn.completed` -> `session.end`; when it carries `usage`,
 *   `usage_source: 'reported'`.
 * - Unlike every other event above, "no `turn.completed` (or one with no
 *   `usage`) was ever seen" can only be known once the stream has ended, so
 *   that zero-token `session.end` with `usage_source: 'manual'` ("so they
 *   are visibly missing rather than silently wrong", docs/adapters.md) is
 *   `flush()`'s job, not `push()`'s.
 */
export function createStreamParser({ cwd } = {}) {
  let sessionId = null;
  let sawUsage = false;

  function pushLine(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return [];
    }
    const ts = new Date().toISOString();

    if (obj.type === 'thread.started') {
      sessionId = obj.thread_id ?? sessionId;
      return [{ ts, type: 'session.start', session_id: sessionId }];
    }

    if (obj.type === 'item.started' && obj.item && TOOL_ITEM_TYPES.has(obj.item.type)) {
      return [
        {
          ts,
          type: 'tool.call',
          tool: obj.item.type,
          args_summary: capSummary(obj.item.command ?? obj.item.path ?? obj.item, cwd),
        },
      ];
    }

    if (obj.type === 'item.completed' && obj.item && TOOL_ITEM_TYPES.has(obj.item.type)) {
      const ok = obj.item.exit_code === undefined || obj.item.exit_code === 0;
      const event = { ts, type: 'tool.result', tool: obj.item.type, ok };
      if (!ok) event.error = capSummary(obj.item.error ?? obj.item.aggregated_output ?? '', cwd);
      return [event];
    }

    // Best-effort, undocumented shape (Phase 1a real-batch fix F1, see
    // src/adapters/error-event.mjs's own doc comment): Codex's real
    // `exec --json` error-on-provider-failure shape is not captured
    // anywhere in this kit yet, so a top-level `{"type":"error",...}` line
    // is translated the same way opencode.mjs's own (verified) `error`
    // shape is - `status_code` from whichever common field name is
    // actually present, `retryable` only from a numeric status in the well
    // known transient set (429/500/502/503/504), never invented when
    // absent.
    if (obj.type === 'error') {
      const errObj = obj.error ?? {};
      const statusCode = firstStatusCode(errObj.status_code, errObj.statusCode, obj.status_code, obj.statusCode);
      const message = errObj.message ?? obj.message ?? '';
      return [
        {
          ts,
          type: 'error',
          severity: 'halt',
          status_code: statusCode,
          retryable: retryableFromStatus(statusCode),
          message: capSummary(message, cwd),
        },
      ];
    }

    if (obj.type === 'turn.completed') {
      const usage = obj.usage;
      if (usage) {
        sawUsage = true;
        return [
          {
            ts,
            type: 'session.end',
            session_id: sessionId,
            tokens_in: usage.input_tokens ?? 0,
            tokens_out: usage.output_tokens ?? 0,
            cost_usd: 0,
            requests: 1,
            usage_source: 'reported',
          },
        ];
      }
      return [];
    }

    return [];
  }

  return {
    push: pushLine,
    flush() {
      if (sawUsage) return [];
      return [
        {
          ts: new Date().toISOString(),
          type: 'session.end',
          session_id: sessionId,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: 0,
          requests: 0,
          usage_source: 'manual',
        },
      ];
    },
  };
}

/**
 * parseStream(lines, { cwd }) -> normalized events, batch form. A thin
 * wrapper over createStreamParser() kept for the existing unit tests (and
 * run()'s own non-detached path below) - see createStreamParser()'s doc
 * comment for the translation rules. `cwd`, forwarded straight through,
 * keeps a tool item's own absolute-path `command`/`path` out of
 * `args_summary`/`error` (see `capSummary`/`relativizeToCwd`); omitted,
 * every existing caller behaves exactly as before.
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
  const { prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth, timeoutMs, detach, onEvent } = opts;
  const { cmd, args, env, stdin: stdinText, promptDelivery, promptDeliveryEvent: pdEvent } = buildArgv({
    prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth,
  });

  const earlyEvents = pdEvent ? [pdEvent] : [];
  for (const event of earlyEvents) onEvent?.(event);

  mkdirSync(outDir, { recursive: true });
  // stdin is closed (docs/adapters.md "codex": "an open stdin hangs the
  // process") UNLESS this launch's prompt delivery is 'stdin' (Blocker 1,
  // src/adapters/prompt-delivery.mjs) - in that case it is piped, written
  // with the exact prompt text, and explicitly closed right after, which is
  // what tells codex the input is complete rather than leaving it open and
  // waiting.
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: [stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
  });
  writeFileSync(join(outDir, 'pid.txt'), String(child.pid ?? ''));
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
  for (const event of parsedEvents) onEvent?.(event);

  // The NDJSON stream has no real subprocess exit code of its own; patch the
  // actual one from the spawned process onto session.end so downstream
  // consumers (ingest) see the true result instead of an absent field.
  const endEvent = [...parsedEvents].reverse().find((e) => e.type === 'session.end');
  if (endEvent && endEvent.exit_code === undefined) endEvent.exit_code = exitCode;

  const events = [...earlyEvents, ...parsedEvents];

  writeFileSync(join(outDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  writeFileSync(join(outDir, 'out.txt'), redact(stdout || stderr));
  writeFileSync(join(outDir, 'exit.txt'), String(exitCode));
  writeFileSync(join(outDir, 'elapsed_ms.txt'), String(elapsedMs));
  writeFileSync(join(outDir, 'done.marker'), '');

  const toolCalls = events.filter((e) => e.type === 'tool.call').length;

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
