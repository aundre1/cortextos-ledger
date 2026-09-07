// OpenCode plugin - the authoritative source of events.jsonl for the
// opencode adapter (docs/adapters.md "opencode": "the JSON stream has been
// observed to end before the final step event, [so] the adapter relies on
// the kit's OpenCode plugin ... for the authoritative events.jsonl").
//
// Ported and genericized from the Phase 1 pilot's cortexos/opencode/plugins/
// cortexos-ledger.js (read via Desktop Commander): env var names moved from
// the pilot's CORTEXOS_* to this kit's CORTEX_* scheme, the default run
// directory moved from `.cortexos-runs/<task>` to `.cortex/events.jsonl`
// (docs/adapters.md default), and this version adds `ms` timing per tool
// call plus secrets redaction and a 200-character cap on free text fields,
// which the pilot version did neither of.
//
// Hooks relied on (OpenCode plugin API):
//   tool.execute.before   - fires just before a tool call runs
//   tool.execute.after    - fires just after a tool call finishes
//   session.created       - a session started
//   session.idle          - a session went idle (this kit treats it as the
//                           end of the run's active turn)
//   session.error         - a session errored out
//   message.updated       - an assistant message was updated; carries
//                           per-message token/cost usage when finished
//
// Holds no database handle - append only to a plain file, so a killed
// OpenCode process can never corrupt a write another process is mid-way
// through (docs/adapters.md "Concurrency note").

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ARGS_SUMMARY_MAX = 200;

// Duplicated from src/adapters/credential-boundary.mjs's PATTERNS/redact
// rather than imported: this file ships standalone into an operator's
// OpenCode plugin directory (docs/adapters.md), which has no guarantee the
// rest of this kit is anywhere on its module resolution path.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abp]-[A-Za-z0-9-]+/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[A-Za-z0-9_-]+/g,
  /nvapi-[A-Za-z0-9_-]{10,}/g,
];

function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

function summarize(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  const safe = redact(text);
  return safe.length > ARGS_SUMMARY_MAX ? safe.slice(0, ARGS_SUMMARY_MAX) : safe;
}

export default async ({ directory }) => {
  const eventsPath = process.env.CORTEX_EVENTS_PATH || join(directory, '.cortex', 'events.jsonl');
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
  } catch {
    // best effort; the write below will simply fail silently too
  }

  const write = (event) => {
    try {
      appendFileSync(eventsPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', 'utf8');
    } catch {
      // Never let ledger IO break the agent's actual work.
    }
  };

  const startedAtByCallId = new Map();

  return {
    'tool.execute.before': async (input) => {
      startedAtByCallId.set(input?.callID, Date.now());
      write({ type: 'tool.call', tool: input?.tool ?? null, args_summary: summarize(input?.args ?? {}) });
    },

    'tool.execute.after': async (input, output) => {
      const startedAt = startedAtByCallId.get(input?.callID);
      startedAtByCallId.delete(input?.callID);
      const ms = startedAt != null ? Date.now() - startedAt : null;
      const ok = !output?.error;
      const event = { type: 'tool.result', tool: input?.tool ?? null, ok, ms };
      if (!ok) event.error = summarize(output.error);
      write(event);
    },

    'session.created': async (input) => {
      const session = input?.info ?? input;
      write({ type: 'session.start', session_id: session?.id ?? null, model: session?.modelID ?? session?.modelId ?? null });
    },

    'session.idle': async (input) => {
      write({ type: 'session.end', session_id: input?.sessionID ?? input?.sessionId ?? null, exit_code: 0 });
    },

    'session.error': async (input) => {
      write({
        type: 'session.end',
        session_id: input?.sessionID ?? input?.sessionId ?? null,
        exit_code: 1,
        error: summarize(input?.error),
      });
    },

    'message.updated': async (input) => {
      const message = input?.info ?? input?.message ?? input;
      if (!message || message.role !== 'assistant') return;
      const tokens = message.tokens ?? {};
      write({
        type: 'message',
        role: 'assistant',
        session_id: message.sessionID ?? message.sessionId ?? null,
        tokens_in: tokens.input ?? 0,
        tokens_out: tokens.output ?? 0,
        cost_usd: message.cost ?? 0,
      });
    },
  };
};
