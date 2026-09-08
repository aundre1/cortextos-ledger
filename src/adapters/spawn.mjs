// Detached launch helper (docs/adapters.md "spawn helper and credential
// boundary", Fable arbitration 2026-09-07: runner.mjs is the detached
// wrapper process; this module spawns *that* wrapper, detached itself, and
// returns immediately). Real adapters (claude/codex/opencode, owned by
// executor C) call `buildArgv()` to get { cmd, args, env } and hand it to
// `launchDetached` here; the fake adapter runs in-process instead and never
// needs this file.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  const env = { ...process.env, ...(argv.env ?? {}) };
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
 */
export async function waitForDoneMarker(outDir, { timeoutMs = 60 * 60 * 1000, stepMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(join(outDir, 'done.marker'))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
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
