// Credential boundary: filterEnv strips secrets from a child process's
// environment before every spawn (docs/security.md "Credential boundary").
// Applied by every adapter in this file's directory before it spawns a
// harness.
//
// Ported and genericized from the Phase 1 pilot's runtime/adapters/
// credential-boundary.mjs (read via Desktop Commander): the pilot's
// `isolatedEnv(source, engine)` becomes `filterEnv(env, { adapter, auth })`
// here, reshaped onto this kit's exact rule list (docs/security.md rules 1
// and 2) instead of the pilot's ad hoc regex, and its `openCodeModel`
// allowlist-of-providers check becomes the simpler `rejectAnthropicModel`
// that docs/security.md rule 3 and docs/adapters.md's "Model rule" actually
// describe (deny-a-name rather than allow-a-prefix). No absolute paths or
// personal identifiers carried over from the original.

import { PATTERNS as SECRET_PATTERNS } from '../guards/secrets-scan.mjs';

const ALWAYS_STRIP = [/^ANTHROPIC_/i, /^CLAUDE_/i, /^CORTEX_PROXY_/i];
const CLAUDE_ADAPTER_STRIP = [/^OPENAI_/i, /^NVIDIA_/i, /^NIM_/i, /^GOOGLE_API_KEY$/i, /^GEMINI_API_KEY$/i];

/**
 * filterEnv(env, { adapter, auth }) -> a new plain object, `env` with
 * secrets removed. Never mutates `env`.
 *
 * Rule 1 (docs/security.md): every child, every adapter - strip
 * `^ANTHROPIC_`, `^CLAUDE_`, `^CORTEX_PROXY_`.
 * Rule 2: the `claude` adapter additionally strips `^OPENAI_`, `^NVIDIA_`,
 * `^NIM_`, `GOOGLE_API_KEY`, `GEMINI_API_KEY` - one harness, one provider.
 * Exception: `adapter: 'claude', auth: 'api'` is the operator's explicit
 * choice to bill the API instead of the subscription (docs/adapters.md
 * "Subscription rule"), so `ANTHROPIC_API_KEY` alone survives rule 1's
 * `ANTHROPIC_` strip; every other `ANTHROPIC_*` variable is still removed.
 */
export function filterEnv(env = {}, { adapter, auth } = {}) {
  const keepAnthropicApiKey = adapter === 'claude' && auth === 'api';
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (keepAnthropicApiKey && key === 'ANTHROPIC_API_KEY') {
      out[key] = value;
      continue;
    }
    if (ALWAYS_STRIP.some((re) => re.test(key))) continue;
    if (adapter === 'claude' && CLAUDE_ADAPTER_STRIP.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Throws an Error with `.code = 1` (docs/state-machine.md exit code table)
 * when `model` names an Anthropic model. Anthropic subscription OAuth may
 * not be used inside a third party harness (docs/security.md rule 3,
 * docs/adapters.md "Model rule") - called first, before building argv, by
 * any adapter that is not `claude` itself.
 */
export function rejectAnthropicModel(model) {
  if (typeof model === 'string' && /claude|anthropic/i.test(model)) {
    const err = new Error(
      `model refused: Anthropic models may not run inside a third party harness: ${model}`
    );
    err.code = 1;
    throw err;
  }
}

// Secrets patterns (docs/guards.md "Secrets in tree" row), shared here so
// preflight's secrets scanner and every adapter's event-summary redaction
// use exactly one list, per docs/security.md ("The boundary is a pure
// function ... operators who want a different policy edit the config
// allowlist, not the code"). src/guards/secrets-scan.mjs owns the canonical
// { label, regex } list (in docs/guards.md's exact order); this is that same
// list's regexes only, re-exported flat for `redact()`'s global-replace loop
// and for anything else that only needs to match, not label, a finding.
// Previously this file kept its own separate copy of these patterns -
// unified per the wave's cross-module seams so there is exactly one
// definition to keep in sync with the docs.
export const PATTERNS = SECRET_PATTERNS.map((p) => p.regex);

/** Every matched secret in `text` replaced with the literal '[REDACTED]'. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(new RegExp(pattern.source, 'g'), '[REDACTED]');
  }
  return out;
}
