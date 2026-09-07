// docs/adapters.md "opencode (OpenCode)". Same interface as every adapter:
// buildArgv, parseStream, run(opts). `plugins/opencode/cortex-ledger.js` is
// authoritative for events.jsonl here - "the JSON stream has been observed
// to end before the final step event" (docs/adapters.md), so this adapter's
// own stdout parsing is a best-effort fallback only, used when the plugin's
// file is not found at `CORTEX_EVENTS_PATH`.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { platform } from 'node:process';
import { filterEnv, rejectAnthropicModel, redact } from './credential-boundary.mjs';

const ARGS_SUMMARY_MAX = 200;
const NORMALIZED_TYPES = new Set(['session.start', 'tool.call', 'tool.result', 'message', 'session.end']);

function capText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  const safe = redact(text);
  return safe.length > ARGS_SUMMARY_MAX ? safe.slice(0, ARGS_SUMMARY_MAX) : safe;
}

/**
 * buildArgv({ prompt, cwd, agent, model, dataHome, outDir, auth }) ->
 * { cmd, args, cwd, env }. `dataHome` is joined with `agent` to isolate each
 * agent's OpenCode data directory (docs/adapters.md "Concurrency note": two
 * OpenCode processes sharing one data directory have deadlocked on OpenCode's
 * own database), exported as `XDG_DATA_HOME` and, on win32, also
 * `LOCALAPPDATA` per this wave's task card. `outDir` (not part of the task
 * card's literal buildArgv signature, but required to compute it - see this
 * executor's final report) sets `CORTEX_EVENTS_PATH` to `<outDir>/events.jsonl`
 * for the plugin. `rejectAnthropicModel` runs before anything else: Anthropic
 * subscription OAuth may not be used inside a third party harness.
 */
export function buildArgv({ prompt, cwd, agent, model, dataHome, outDir, auth }) {
  rejectAnthropicModel(model);

  const env = filterEnv(process.env, { adapter: 'opencode', auth });
  if (dataHome) {
    const agentDataDir = path.join(dataHome, agent || 'default');
    env.XDG_DATA_HOME = agentDataDir;
    if (platform === 'win32') env.LOCALAPPDATA = agentDataDir;
  }
  if (outDir) {
    env.CORTEX_EVENTS_PATH = path.join(outDir, 'events.jsonl');
  }

  return {
    cmd: 'opencode',
    args: ['run', ...(agent ? ['--agent', agent] : []), ...(model ? ['--model', model] : []), '--format', 'json', prompt],
    cwd,
    env,
  };
}

/**
 * parseStream(lines) -> normalized events, best effort (docs/adapters.md
 * "opencode"). A line that already carries a recognized normalized `type`
 * (this is what the plugin's events.jsonl - and this fixture format - looks
 * like) is passed through, but its free text fields are re-redacted and
 * re-capped rather than trusted blindly. Anything else is treated as
 * OpenCode's own raw `run --format json` stdout and translated on a
 * best-effort basis; that stream is not authoritative (see the module
 * comment above), so unrecognized shapes are simply skipped.
 */
export function parseStream(lines) {
  const events = [];
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

    if (NORMALIZED_TYPES.has(obj.type)) {
      const event = { ...obj };
      if (typeof event.args_summary === 'string') event.args_summary = capText(event.args_summary);
      if (typeof event.error === 'string') event.error = capText(event.error);
      events.push(event);
      continue;
    }

    const sessionId = obj.sessionID ?? obj.sessionId ?? null;
    if (sessionId) {
      events.push({ ts: new Date().toISOString(), type: 'session.start', session_id: sessionId });
    }
  }
  return events;
}

/** run(opts) per the interface at the top of docs/adapters.md. */
export async function run(opts) {
  const { prompt, cwd, agent, model, dataHome, outDir, auth, timeoutMs, detach, onEvent } = opts;
  const { cmd, args, env } = buildArgv({ prompt, cwd, agent, model, dataHome, outDir, auth });

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

  const ownEvents = parseStream(stdout.split('\n'));
  for (const event of ownEvents) onEvent?.(event);

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
