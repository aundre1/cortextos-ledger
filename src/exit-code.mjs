// Exit code normalization (Phase 1a real-batch fix F3). Real production
// evidence: one run on the Windows target machine recorded
// `task_runs.exit_code = 4294967295` (0xFFFFFFFF) with an empty out.txt -
// PowerShell/Windows report a negative native process exit code as an
// unsigned 32 bit integer (`$LASTEXITCODE`, a killed/crashed process's own
// return code), which is `-1` as a signed 32 bit integer, not a real
// four-billion-and-change exit status. Applied everywhere an exit code is
// persisted (src/adapters/runner.mjs, every adapter's own run(), run:end's
// --exit flag and its exit.txt read, and src/ingest.mjs's session.end
// patch), so the ledger only ever stores the signed value a human or a
// script would recognize.

/**
 * `n` is treated as an unsigned 32 bit exit code (Windows convention for a
 * negative native process exit code) when it is an integer strictly greater
 * than `2147483647` (INT32_MAX) and at most `4294967295` (UINT32_MAX,
 * 0xFFFFFFFF) - the range no real POSIX exit code (0-255) or Node
 * child_process exit code ever legitimately occupies. Converted to its
 * signed 32 bit equivalent (`n - 4294967296`); every other value, including
 * `null`/`undefined`/non finite input, is returned completely unchanged -
 * this function never invents a value the caller did not already have.
 */
export function normalizeExitCode(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) return n;
  if (n > 2147483647 && n <= 4294967295) return n - 4294967296;
  return n;
}
