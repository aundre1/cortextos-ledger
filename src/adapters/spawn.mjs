// Detached launch helper (docs/adapters.md "spawn helper and credential
// boundary", Fable arbitration 2026-09-07: runner.mjs is the detached
// wrapper process; this module spawns *that* wrapper, detached itself, and
// returns immediately). Real adapters (claude/codex/opencode, owned by
// executor C) call `buildArgv()` to get { cmd, args, env } and hand it to
// `launchDetached` here; the fake adapter runs in-process instead and never
// needs this file.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows command resolution (docs/adapters.md "Windows command
// resolution"): re-exported from here so every caller that already imports
// spawn helpers from this module can reach it without a second import path.
export {
  resolveCommand,
  resolveConfiguredCommand,
  applyResolvedCommand,
  escapeCmdArg,
} from './resolve-command.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(HERE, 'runner.mjs');

/**
 * Spawn src/adapters/runner.mjs as a detached child that itself spawns
 * `argv.cmd`. Returns immediately with { runnerPid } - the runner process's
 * own pid, not the harness's (the harness's pid lands in <outDir>/pid.txt,
 * written by the runner once it has spawned it).
 *
 * `adapter` (review round 1, F2) names the adapter module (`claude` |
 * `codex` | `opencode` | `fake`) so the runner can dynamically import it and
 * tee the harness's stdout through its `createStreamParser()`, when it has
 * one, into `eventsPath` live; omit both to get the runner's old behaviour
 * (redacted out.txt only, no events.jsonl of its own).
 *
 * `initialEvents` (D1, opencode's `credentials.forwarded`/`credentials.
 * missing` bookkeeping): normalized events already known before the harness
 * even spawns, seeded into `eventsPath` immediately after runner.mjs's own
 * fresh-per-run truncation and before the child starts - the only place that
 * write can safely land, since runner.mjs always truncates `eventsPath` to
 * empty at the very start of its own run (out dirs are reused across
 * retries) and would otherwise silently wipe anything written here first.
 * Adapter-agnostic: runner.mjs does not know or care why these events
 * exist, only that they come first.
 *
 * `stdinFile` (Blocker 1, `src/adapters/prompt-delivery.mjs`): an absolute
 * path to a file already written to disk (by the caller - see
 * src/commands/runs.mjs `launchAttempt`) whose exact bytes the harness
 * should receive on its own real stdin, for a prompt too large to ever pass
 * through this (or any) process's argv. The path is short and safe to pass
 * here even when the file it names holds tens of thousands of characters -
 * the whole point of this indirection is that the large content never
 * becomes an argv element on the way to the detached runner either.
 */
export function launchDetached({ argv, cwd, outDir, timeoutMs, adapter, eventsPath, initialEvents, stdinFile }) {
  mkdirSync(outDir, { recursive: true });
  const runnerArgs = [
    RUNNER_PATH,
    '--out',
    outDir,
    '--cwd',
    cwd,
    ...(timeoutMs !== undefined ? ['--timeout-ms', String(timeoutMs)] : []),
    ...(adapter ? ['--adapter', adapter] : []),
    ...(eventsPath ? ['--events', eventsPath] : []),
    ...(initialEvents && initialEvents.length ? ['--initial-events', JSON.stringify(initialEvents)] : []),
    ...(stdinFile ? ['--stdin-file', stdinFile] : []),
    '--',
    argv.cmd,
    ...(argv.args ?? []),
  ];
  // Codex round, F1 (blocker): every adapter's buildArgv already returns a
  // COMPLETE environment via credential-boundary.mjs's filterEnv(process.env,
  // ...) - filterEnv copies every key of its input except the ones its rules
  // strip, so argv.env already carries everything the child needs (PATH
  // included) minus the secrets the boundary is meant to remove. Spreading
  // process.env again here as the base, with argv.env only overlaid on top,
  // silently restored every key argv.env had deliberately omitted (an
  // omitted key never overrides anything, it just leaves the base's value
  // standing) - so ANTHROPIC_API_KEY/OPENAI_API_KEY etc. reached this
  // process's own env (inherited by runner.mjs, and from there the harness
  // it spawns) whenever this process happened to have them set, defeating
  // the boundary entirely. Confirmed with a real child process launched
  // through this exact path. Use argv.env as-is; do not re-merge process.env.
  const env = { ...(argv.env ?? {}) };
  const child = spawn(process.execPath, runnerArgs, {
    cwd,
    env,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return { runnerPid: child.pid };
}

/**
 * Parse <outDir>/pid.txt (written by runner.mjs, per docs/adapters.md
 * "spawn helper and credential boundary") into a positive integer pid, or
 * null if the file is missing, empty, or does not parse - never throws.
 * Review round 2, R2-1: this is the shared fallback both run:launch (which
 * polls it - see pollPidFile below) and the watchdog (which reads it
 * on-demand when task_runs.pid was never populated) use to recover the
 * harness's real OS pid.
 */
export function readPidFile(pidPath) {
  if (!pidPath || !existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Poll for pid.txt to appear and parse, up to timeoutMs in stepMs steps (no
 * long sleeps - review round 2, R2-1: run:launch calls this right after
 * launchDetached so task_runs.pid is populated as soon as the runner has
 * spawned the harness, rather than staying null until a stall or wall clock
 * breach forces the watchdog to fall back to reading the file itself).
 * Returns the parsed pid, or null if it never appears/parses within the
 * deadline.
 */
export async function pollPidFile(pidPath, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = readPidFile(pidPath);
    if (pid != null) return pid;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * Poll for `<outDir>/done.marker` to appear, up to `timeoutMs` in `stepMs`
 * steps (`run:launch --retry`, Phase 1a real-batch fix F1: a retry decision
 * needs the run to have actually finished before `run:end` can classify
 * it). Returns `true` once found, `false` if it never appears within the
 * deadline - the watchdog (docs/state-machine.md "Wall clock watchdog") is
 * what guarantees a wedged run eventually gets a done.marker one way or
 * another, so `timeoutMs` here is a generous safety net on top of that, not
 * the enforcement mechanism itself.
 *
 * Real Phase 1a defect (retry directory reuse): `sinceMs`, when given, is
 * this attempt's own `started_at` (as epoch ms) - a marker that already
 * exists but is OLDER than that is a PREVIOUS attempt's leftover, not this
 * one's, and must not satisfy the wait. This is belt-and-braces, not the
 * primary fix: `launchAttempt` (src/commands/runs.mjs) now calls
 * `archivePriorAttempt` before every spawn precisely so `outDir` is already
 * clean and a marker found here can only ever belong to the current attempt
 * - but a marker's mtime is cheap to check and this is exactly the kind of
 * invariant that is worth verifying rather than trusting, given that trusting
 * an identical invariant (a fresh out dir) is exactly what the original bug
 * silently violated. Omitting `sinceMs` keeps every pre-existing caller's
 * behaviour (and every existing test's) unchanged.
 */
export async function waitForDoneMarker(outDir, { timeoutMs = 60 * 60 * 1000, stepMs = 250, sinceMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  const markerPath = join(outDir, 'done.marker');
  for (;;) {
    if (existsSync(markerPath) && (sinceMs === undefined || markerMtimeAtOrAfter(markerPath, sinceMs))) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// A real, timing-sensitive discovery while testing this fix: in `--sync`
// mode (and, more rarely, even on the real detached path) the gap between
// `run.started_at` (a JS `Date`, millisecond resolution, captured at
// `insertRun`) and the moment `done.marker` is actually written can be a
// single-digit number of milliseconds or less - well inside the noise floor
// between `Date.now()`'s clock source and whatever clock the filesystem
// stamps `mtime` from. A strict `mtimeMs >= sinceMs` intermittently rejected
// a marker that was, in reality, written a fraction of a millisecond AFTER
// `started_at`, which then spun this function for the full `timeoutMs` (up
// to `wallclock_s`, i.e. actual minutes) waiting for an mtime that would
// never move, since nothing ever rewrites an already-written done.marker.
// This tolerance absorbs that jitter without meaningfully weakening the
// check's actual job: it exists to catch a stale marker left over from a
// genuinely PREVIOUS attempt (one `archivePriorAttempt` should have already
// archived away - see this file's own comment above), which - if it is ever
// seen at all, i.e. if that primary defense has itself regressed - is from
// a categorically earlier CLI invocation, not a same-attempt race, and so is
// virtually certain to be older than this by much more than a few seconds
// regardless of how small `--retry-backoff-s` is configured.
const CLOCK_SKEW_TOLERANCE_MS = 5000;

function markerMtimeAtOrAfter(markerPath, sinceMs) {
  try {
    return statSync(markerPath).mtimeMs >= sinceMs - CLOCK_SKEW_TOLERANCE_MS;
  } catch {
    // Vanished between existsSync and stat (exceptionally unlikely for a
    // marker file nothing else touches) - treat as not-yet-done and keep
    // polling rather than throwing out of the retry loop.
    return false;
  }
}

// Real Phase 1a defect (retry directory reuse): every attempt of the same
// (task, agent) writes into the SAME out dir, `<runs>/<task>/<agent>`
// (docs/architecture.md's runtime layout is per task+agent, not per run) -
// runner.mjs truncates only out.txt/events.jsonl fresh per run, and never
// touches done.marker/exit.txt/elapsed_ms.txt/pid.txt at all. A retried
// attempt (or any later relaunch of the same task+agent) therefore starts in
// a directory that still holds the PRIOR attempt's done.marker/exit.txt: in
// `run:launch --retry`, `waitForDoneMarker` saw that stale marker and
// returned immediately, and `run:end` then classified the NEW run entirely
// from the OLD attempt's exit.txt/events.jsonl - see this file's own
// `waitForDoneMarker` and `src/commands/runs.mjs`'s `doRunEnd` doc comments,
// and docs/state-machine.md "Provider unavailable".
//
// The owner's standing rule is archive, never delete: this function moves
// (never deletes, never copies-then-deletes-the-original - a straight
// `renameSync`) every artifact file the previous attempt left in `outDir`
// into `<outDir>/attempts/<archiveKey>/`, leaving `outDir` itself clean for
// the attempt about to spawn. `archiveKey` is normally the previous run's id
// (the caller, `src/commands/runs.mjs`'s `launchAttempt`, looks it up from
// the ledger); when no previous run id can be determined there, a UTC
// timestamp is used instead (this function's own fallback, so a caller that
// cannot name one need not invent one either).
const ATTEMPT_ARTIFACT_FILES = [
  'done.marker',
  'exit.txt',
  'elapsed_ms.txt',
  'events.jsonl',
  'out.txt',
  'pid.txt',
  'prompt.txt',
  // Agent-produced files (docs/guards.md's "well-known files a run's out_dir
  // may contain", the same set src/ingest.mjs's ARTIFACT_FILES records):
  // left out of the confirmed-defect's own file list (which only named the
  // runner/watchdog bookkeeping files that made `waitForDoneMarker`/
  // `doRunEnd` misfire) but just as capable of bleeding a stale result into
  // a new attempt if left behind - a leftover `patch.diff` from a run that
  // 429'd after partially writing one would make `missingPatch` (src/guards/
  // postrun.mjs) wrongly see a patch for a *later* attempt that produced
  // none of its own.
  'patch.diff',
  'reasoning.md',
  'verdict.json',
];

// A previous attempt is only considered to have "really" run here (as
// opposed to an out dir that merely exists but was never launched into) when
// at least one of these is present - pid.txt/elapsed_ms.txt/prompt.txt can
// in principle be written without a done.marker/exit.txt/events.jsonl/out.txt
// ever following (a hard kill before the runner finishes), so archiving still
// picks all seven up once any of these four is seen.
const ATTEMPT_TRIGGER_FILES = ['done.marker', 'exit.txt', 'events.jsonl', 'out.txt'];

/** Windows path segments cannot contain ':' - the same filesystem-safe timestamp convention used elsewhere in this kit for a fallback archive key. */
function utcStampArchiveKey(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * If `outDir` already holds evidence of a previous attempt, move every
 * known attempt-artifact file present into `<outDir>/attempts/<archiveKey>/`
 * (creating it) and return that directory's absolute path. Returns `null`,
 * touching nothing, when `outDir` shows no sign of a previous attempt (the
 * normal case for this task+agent's very first run).
 */
export function archivePriorAttempt(outDir, archiveKey) {
  const present = ATTEMPT_ARTIFACT_FILES.filter((name) => existsSync(join(outDir, name)));
  if (!present.some((name) => ATTEMPT_TRIGGER_FILES.includes(name))) return null;

  const dest = join(outDir, 'attempts', archiveKey ?? utcStampArchiveKey());
  mkdirSync(dest, { recursive: true });
  for (const name of present) {
    renameSync(join(outDir, name), join(dest, name));
  }
  return dest;
}

/** Kill a process tree by pid: `taskkill /T /F` on Windows, process group SIGKILL elsewhere. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch {
      // best effort
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
