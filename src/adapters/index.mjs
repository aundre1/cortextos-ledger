// Adapter registry (Fable arbitration 2026-09-07: owned by executor B;
// executor C writes the adapter files themselves and never edits this one).
// Resolves an adapter name to its module via dynamic import from a fixed
// allowlist - never an arbitrary import(name), so a task or config value can
// never make the kit import an unintended file.

const ALLOWED = ['fake', 'claude', 'codex', 'opencode'];

/** Import and return the adapter module for `name`. Throws Error(.code=1) for anything not on the allowlist. */
export async function getAdapter(name) {
  if (!ALLOWED.includes(name)) {
    const e = new Error(`unknown adapter: ${name} (allowed: ${ALLOWED.join(', ')})`);
    e.code = 1;
    throw e;
  }
  return import(`./${name}.mjs`);
}

export const ADAPTER_NAMES = [...ALLOWED];
