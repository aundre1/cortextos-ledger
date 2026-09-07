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
 * buildArgv({ prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth })
 * per docs/adapters.md: stdin is always closed by run() (an open stdin hangs
 * the process); `--sandbox` defaults to `read-only` for reviewer roles
 * (`readOnly: true`) and `workspace-write` otherwise; `danger-full-access`
 * is refused outright, whether it arrived as an explicit `sandbox` or as a
 * default (there is no default that resolves to it). A resumed thread never
 * accepts `--sandbox` (Codex would otherwise inherit `~/.codex/config.toml`),
 * so it force-sets `-c sandbox_mode="read-only"` instead.
 */
export function buildArgv({ prompt, cwd, sandbox, readOnly, outDir, resumeThreadId, auth }) {
  const lastMessagePath = join(outDir, 'last-message.md');

  if (resumeThreadId) {
    return {
      cmd: 'codex',
      args: ['exec', 'resume', resumeThreadId, '-c', 'sandbox_mode="read-only"', '--json', '-o', lastMessagePath, prompt],
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
    cmd: 'codex',
    args: ['exec', '--json', '--sandbox', chosenSandbox, '--cd', cwd, '-o', lastMessagePath, prompt],
    cwd,
    env: filterEnv(process.env, { adapter: 'codex', auth }),
  };
}

/**
 * parseStream(lines) -> normalized events from Codex's `exec --json` NDJSON
 * (docs/adapters.md: "Parse the NDJSON for `thread.started` (session id),
 * item events (tool calls), and `turn.completed` usage when present").
 *
 * - `thread.started` -> `session.start`.
 * - `item.started` / `item.completed` on a tool-shaped item
 *   (`command_execution`, `file_change`, `mcp_tool_call`) -> `tool.call` /
 *   `tool.result`.
 * - `turn.completed` -> `session.end`; when it carries `usage`,
 *   `usage_source: 'reported'`. When no `turn.completed` (or one with no
 *   `usage`) is ever seen, a `session.end` with zero tokens and
 *   `usage_source: 'manual'` is synthesized, "so they are visibly missing
 *   rather than silently wrong" (docs/adapters.md).
 */
export function parseStream(lines) {
  const events = [];
  let sessionId = null;
  let sawUsage = false;
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');

  for (const raw of list) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) continue;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      continue;
    }
    const ts = new Date().toISOString();

    if (obj.type === 'thread.started') {
      sessionId = obj.thread_id ?? sessionId;
      events.push({ ts, type: 'session.start', session_id: sessionId });
      continue;
    }

    if (obj.type === 'item.started' && obj.item && TOOL_ITEM_TYPES.has(obj.item.type)) {
      events.push({
        ts,
        type: 'tool.call',
        tool: obj.item.type,
        args_summary: capSummary(obj.item.command ?? obj.item.path ?? obj.item),
      });
      continue;
    }

    if (obj.type === 'item.completed' && obj.item && TOOL_ITEM_TYPES.has(obj.item.type)) {
      const ok = obj.item.exit_code === undefined || obj.item.exit_code === 0;
      const event = { ts, type: 'tool.result', tool: obj.item.type, ok };
      if (!ok) event.error = capSummary(obj.item.error ?? obj.item.aggregated_output ?? '');
      events.push(event);
      continue;
    }

    if (obj.type === 'turn.completed') {
      const usage = obj.usage;
      if (usage) {
        sawUsage = true;
        events.push({
          ts,
          type: 'session.end',
          session_id: sessionId,
          tokens_in: usage.input_tokens ?? 0,
          tokens_out: usage.output_tokens ?? 0,
          cost_usd: 0,
          requests: 1,
          usage_source: 'reported',
        });
      }
      continue;
    }
  }

  if (!sawUsage) {
    events.push({
      ts: new Date().toISOString(),
      type: 'session.end',
      session_id: sessionId,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      requests: 0,
      usage_source: 'manual',
    });
  }

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
