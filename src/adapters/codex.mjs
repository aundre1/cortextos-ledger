// docs/adapters.md "codex (Codex CLI)". Same interface as every adapter:
// buildArgv, parseStream, run(opts).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterEnv, redact } from './credential-boundary.mjs';

const ARGS_SUMMARY_MAX = 200;
const TOOL_ITEM_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call']);

function capSummary(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  const safe = redact(text);
  return safe.length > ARGS_SUMMARY_MAX ? safe.slice(0, ARGS_SUMMARY_MAX) : safe;
}

/**
 * buildArgv({ prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth,
 * cmd, argsPrefix }) per docs/adapters.md: stdin is always closed by run()
 * (an open stdin hangs the process); `--sandbox` defaults to `read-only` for
 * reviewer roles (`readOnly: true`) and `workspace-write` otherwise;
 * `danger-full-access` is refused outright, whether it arrived as an
 * explicit `sandbox` or as a default (there is no default that resolves to
 * it). A resumed thread never accepts `--sandbox` (Codex would otherwise
 * inherit `~/.codex/config.toml`), so it force-sets
 * `-c sandbox_mode="read-only"` instead. `cmd`/`argsPrefix` (review round 1,
 * F2 test harness) override the executable and prepend extra argv - default
 * cmd is `codex` - so a stub binary (`config.adapters.codex.cmd`/
 * `argsPrefix`) can stand in for the real CLI in tests.
 */
export function buildArgv({ prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth, cmd, argsPrefix }) {
  const lastMessagePath = join(outDir, 'last-message.md');
  const prefix = argsPrefix ?? [];

  if (resumeThreadId) {
    return {
      cmd: cmd ?? 'codex',
      args: [...prefix, 'exec', 'resume', resumeThreadId, '-c', 'sandbox_mode="read-only"', '--json', '-o', lastMessagePath, prompt],
      cwd,
      env: filterEnv(process.env, { adapter: 'codex', auth }),
    };
  }

  const chosenSandbox = sandbox ?? (readOnly ? 'read-only' : 'workspace-write');
  if (chosenSandbox === 'danger-full-access') {
    const err = new Error('codex sandbox refused: danger-full-access is never permitted by this kit');
    err.code = 1;
    throw err;
  }

  return {
    cmd: cmd ?? 'codex',
    args: [...prefix, 'exec', '--json', '--sandbox', chosenSandbox, '--cd', cwd, '-o', lastMessagePath, prompt],
    cwd,
    env: filterEnv(process.env, { adapter: 'codex', auth }),
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
export function createStreamParser() {
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
          args_summary: capSummary(obj.item.command ?? obj.item.path ?? obj.item),
        },
      ];
    }

    if (obj.type === 'item.completed' && obj.item && TOOL_ITEM_TYPES.has(obj.item.type)) {
      const ok = obj.item.exit_code === undefined || obj.item.exit_code === 0;
      const event = { ts, type: 'tool.result', tool: obj.item.type, ok };
      if (!ok) event.error = capSummary(obj.item.error ?? obj.item.aggregated_output ?? '');
      return [event];
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
  const { prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth, timeoutMs, detach, onEvent } = opts;
  const { cmd, args, env } = buildArgv({ prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth });

  mkdirSync(outDir, { recursive: true });
  // stdin closed: an open stdin hangs codex exec (docs/adapters.md "codex").
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  writeFileSync(join(outDir, 'pid.txt'), String(child.pid ?? ''));

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

  const events = parseStream(stdout.split('\n'));
  for (const event of events) onEvent?.(event);

  // The NDJSON stream has no real subprocess exit code of its own; patch the
  // actual one from the spawned process onto session.end so downstream
  // consumers (ingest) see the true result instead of an absent field.
  const endEvent = [...events].reverse().find((e) => e.type === 'session.end');
  if (endEvent && endEvent.exit_code === undefined) endEvent.exit_code = exitCode;

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
  };
}
