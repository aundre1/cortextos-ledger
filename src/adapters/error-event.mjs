// Shared helper for the normalized `error` event's `retryable` field
// (docs/adapters.md's normalized event vocabulary; Phase 1a real-batch fix
// F1). Every adapter emits `status_code` (number or null) and `retryable`
// (boolean) on an `error` event, derived honestly from what the harness
// itself reported - never invented.
//
// OpenCode reports its own `error.data.isRetryable` directly (see
// src/adapters/opencode.mjs) - that is the harness's own classification and
// is used as-is, with no whitelist involved. Claude Code's `stream-json` and
// Codex's `exec --json` NDJSON have no documented/observed equivalent flag
// (neither harness's real error-stream shape for a provider failure is
// captured anywhere in this kit yet - see the OPEN QUESTION this raised),
// so for those two adapters `retryable` is derived only from a numeric HTTP
// status the harness actually reported, restricted to the well known
// transient set: 429 (rate limited), 500/502/503/504 (server side). No
// status at all (the common case today, since neither harness's stream
// carries one) means `retryable: false` - conservative, per this task's own
// instruction "do not invent a status the harness did not report".

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

/** `true` only when `statusCode` is one of the well known transient HTTP statuses; `false` for anything else, including `null`/`undefined`/a non-transient code. */
export function retryableFromStatus(statusCode) {
  return typeof statusCode === 'number' && RETRYABLE_HTTP_STATUSES.has(statusCode);
}

/**
 * Best-effort extraction of a numeric HTTP status code from a raw JSON error
 * line, trying the field-name spellings observed across this kit's harnesses
 * (`status_code`, `statusCode`, nested under `.error`/`.error.data`) without
 * assuming any one shape is authoritative. Returns the first candidate that
 * is actually a number, else `null`.
 */
export function firstStatusCode(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'number') return c;
  }
  return null;
}
