// Prompt delivery (Blocker 1, real defect from the owner's machine): a
// review of PR #972 (492 additions) failed to launch with `spawn
// ENAMETOOLONG` - the reviewer's brief is a large string, and every adapter
// passed it as a single argv element. Windows' own `CreateProcess` caps a
// full command line around 32767 characters, and the practical limit
// through `child_process.spawn` is lower still (argv is re-joined into one
// command line string on that platform); POSIX has its own, larger but
// still finite, `ARG_MAX`. Either way, a large prompt must never become an
// argv element on any platform.
//
// The threshold below is deliberately small and platform-independent, per
// this task's own instructions: "any prompt over 8000 characters never goes
// through argv on any platform." This makes the choice deterministic rather
// than dependent on the host's real argv limit (which varies by OS, shell,
// and how much of it this kit's own other args have already used) - a
// prompt this large is never going through argv, full stop. Under the
// threshold, every adapter keeps doing exactly what it did before this
// task, so its existing fixtures/tests stay meaningful.
//
// Verified from each harness's own source before choosing `stdin` as the
// delivery channel for all three real adapters (never `file` - see
// docs/adapters.md "Prompt delivery (Blocker 1)" for the full citation
// trail and exact line numbers):
//   - opencode `run`: reads the whole prompt from stdin when the positional
//     message argument is empty (`resolveRunInput`, packages/opencode/src/
//     cli/cmd/run.ts:40-50, tag v1.18.27).
//   - codex `exec`: reads the prompt from stdin when the positional PROMPT
//     argument is omitted (codex-rs/exec/src/cli.rs:74-77, tag
//     rust-v0.48.0); `codex exec resume` needs the literal `-` passed
//     explicitly to get the same behaviour (same file, ResumeArgs'
//     `prompt` field, :97-99 - omission alone is not documented to work
//     there).
//   - claude `-p`: reads the prompt from stdin when no prompt is given
//     inline after `-p`.
// None of the three needed the file fallback this task also specifies for
// "an adapter with no stdin path" - so `'file'` is a value this module's
// event vocabulary supports (and `docs/ledger.md` documents on
// `task_runs.prompt_delivery`) but nothing in this kit emits today.

export const PROMPT_ARGV_THRESHOLD = 8000;

/**
 * 'argv' (the prompt is a plain argv element, exactly like every adapter did
 * before this task, for anything at or under the threshold) or 'stdin' (over
 * the threshold - the prompt is delivered on the child's stdin instead, and
 * never appears in any argv array this kit builds, on any platform). This
 * function never returns 'file' - no adapter this kit ships needs it - but
 * the value stays part of the vocabulary (see the module comment above) for
 * a future adapter that has no stdin path.
 */
export function choosePromptDelivery(prompt, { threshold = PROMPT_ARGV_THRESHOLD } = {}) {
  const length = typeof prompt === 'string' ? prompt.length : 0;
  return length > threshold ? 'stdin' : 'argv';
}

/**
 * The `prompt.delivery` event every adapter's `buildArgv` emits at launch
 * (this task's own requirement: "the choice must be visible"), `severity:
 * 'info'` - this is bookkeeping, never a failure. `length` is the prompt's
 * own character count, never the prompt text itself.
 */
export function promptDeliveryEvent(delivery, prompt) {
  const length = typeof prompt === 'string' ? prompt.length : 0;
  return { ts: new Date().toISOString(), type: 'prompt.delivery', severity: 'info', delivery, length };
}
