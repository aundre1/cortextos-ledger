// docs/adapters.md "claude (Claude Code)". Same interface as every other
// adapter (see the top of docs/adapters.md): buildArgv is the pure argv
// builder, parseStream turns Claude Code's stream-json lines into this
// kit's normalized events.jsonl format, and run(opts) composes both and
// spawns the harness when not detached.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filterEnv, redact } from './credential-boundary.mjs';

const ARGS_SUMMARY_MAX = 200;

/**
 * buildArgv({ prompt, cwd, model, allowedTools, auth, cmd, argsPrefix }) ->
 * { cmd, args, cwd, env } per docs/adapters.md: prompt is always an
 * argument, never stdin. Permission flags come from config's
 * `allowedTools`; this kit never passes `--dangerously-skip-permissions`
 * (docs/adapters.md "Permissions"). `cmd`/`argsPrefix` (review round 1, F2
 * test harness) override the executable and prepend extra argv - default
 * cmd is `claude`, argsPrefix defaults to none - so a stub binary
 * (`config.adapters.claude.cmd`/`argsPrefix`) can stand in for the real CLI
 * in tests without this function otherwise changing shape.
 */
export function buildArgv({ prompt, cwd, model, allowedTools, auth, cmd, argsPrefix }) {
  return {
    cmd: cmd ?? 'claude',
    args: [
      ...(argsPrefix ?? []),
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      ...(model ? ['--model', model] : []),
      ...(allowedTools && allowedTools.length ? ['--allowedTools', allowedTools.join(',')] : []),
    ],
    cwd,
    env: filterEnv(process.env, { adapter: 'claude', auth }),
  };
}

function capSummary(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  const safe = redact(text);
  return safe.length > ARGS_SUMMARY_MAX ? safe.slice(0, ARGS_SUMMARY_MAX) : safe;
}

/**
 * createStreamParser() -> { push(line) -> events[], flush() -> events[] }
 * (review round 1, F2): the incremental form of the translation described
 * below, driven one raw stdout line at a time by src/adapters/runner.mjs so
 * events.jsonl is written live instead of only ever appearing in a batch
 * after the harness exits. All state (the session id and the tool-name-by-id
 * map used to attach a tool_use's name to its later tool_result) lives in
 * this closure, one per run. `flush()` has nothing to add for Claude Code -
 * every event claude.mjs emits comes directly off a single line - so it
 * always returns [].
 *
 * - `system`/`init` -> `session.start`.
 * - `assistant`/`user` message content: `tool_use` blocks -> `tool.call`;
 *   `tool_result` blocks -> `tool.result` (tool name recovered from the
 *   matching `tool_use.id` seen earlier in the stream); a `usage` block on
 *   the message -> a `message` event.
 * - A message carrying `parent_tool_use_id` is a subagent turn; per
 *   docs/adapters.md ("Subagent messages carry parent_tool_use_id; count
 *   them as tool calls") it also emits one extra `tool.call`.
 * - Final `result` -> `session.end` with `total_cost_usd`, `duration_ms`,
 *   `session_id`, `num_turns` (as `requests`), plus a `result_excerpt` (the
 *   harness's own final text, capped and redacted) used to build a run
 *   summary.
 */
export function createStreamParser() {
  let sessionId = null;
  const toolNameById = new Map();

  function pushLine(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return [];
    }
    const events = [];
    const ts = new Date().toISOString();

    if (obj.type === 'system' && obj.subtype === 'init') {
      sessionId = obj.session_id ?? sessionId;
      events.push({ ts, type: 'session.start', session_id: sessionId, agent: obj.agent ?? null, model: obj.model ?? null });
      return events;
    }

    if (obj.type === 'assistant' || obj.type === 'user') {
      const message = obj.message ?? {};
      const content = Array.isArray(message.content) ? message.content : [];

      if (obj.parent_tool_use_id) {
        events.push({ ts, type: 'tool.call', tool: 'subagent', args_summary: capSummary(message.role ?? obj.type) });
      }

      for (const block of content) {
        if (block.type === 'tool_use') {
          toolNameById.set(block.id, block.name);
          events.push({ ts, type: 'tool.call', tool: block.name, args_summary: capSummary(block.input) });
        } else if (block.type === 'tool_result') {
          const ok = block.is_error !== true;
          const event = { ts, type: 'tool.result', tool: toolNameById.get(block.tool_use_id) ?? null, ok };
          if (!ok) event.error = capSummary(block.content);
          events.push(event);
        }
      }

      if (message.usage) {
        events.push({
          ts,
          type: 'message',
          role: message.role ?? obj.type,
          tokens_in: message.usage.input_tokens ?? 0,
          tokens_out: message.usage.output_tokens ?? 0,
          cost_usd: obj.cost_usd ?? 0,
        });
      }
      return events;
    }

    if (obj.type === 'result') {
      events.push({
        ts,
        type: 'session.end',
        session_id: obj.session_id ?? sessionId,
        exit_code: obj.is_error ? 1 : 0,
        tokens_in: obj.usage?.input_tokens ?? 0,
        tokens_out: obj.usage?.output_tokens ?? 0,
        cost_usd: obj.total_cost_usd ?? 0,
        requests: obj.num_turns ?? 0,
        duration_ms: obj.duration_ms ?? null,
        result_excerpt: typeof obj.result === 'string' ? capSummary(obj.result).slice(0, 300) : null,
      });
      return events;
    }

    return [];
  }

  return {
    push: pushLine,
    flush() {
      return [];
    },
  };
}

/**
 * parseStream(lines) -> normalized events, batch form. `lines` may be an
 * array of raw JSON text lines or a single newline delimited string; blank
 * and unparsable lines are skipped. A thin wrapper over createStreamParser()
 * kept for the existing unit tests (and any other caller that already has
 * the whole stream in hand, e.g. run()'s own non-detached path below) - see
 * createStreamParser()'s own doc comment for the translation rules.
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
  const { prompt, cwd, model, allowedTools, auth, outDir, timeoutMs, detach, onEvent } = opts;
  const { cmd, args, env } = buildArgv({ prompt, cwd, model, allowedTools, auth });

  mkdirSync(outDir, { recursive: true });
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

  writeFileSync(join(outDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  writeFileSync(join(outDir, 'out.txt'), redact(stdout || stderr));
  writeFileSync(join(outDir, 'exit.txt'), String(exitCode));
  writeFileSync(join(outDir, 'elapsed_ms.txt'), String(elapsedMs));
  writeFileSync(join(outDir, 'done.marker'), '');

  const endEvent = [...events].reverse().find((e) => e.type === 'session.end');
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
    summary: endEvent?.result_excerpt ?? '',
  };
}
