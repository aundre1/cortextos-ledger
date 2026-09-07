// Detached launch helper (docs/adapters.md "spawn helper and credential
// boundary", Fable arbitration 2026-09-07: runner.mjs is the detached
// wrapper process; this module spawns *that* wrapper, detached itself, and
// returns immediately). Real adapters (claude/codex/opencode, owned by
// executor C) call `buildArgv()` to get { cmd, args, env } and hand it to
// `launchDetached` here; the fake adapter runs in-process instead and never
// needs this file.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(HERE, 'runner.mjs');

/**
 * Spawn src/adapters/runner.mjs as a detached child that itself spawns
 * `argv.cmd`. Returns immediately with { runnerPid } - the runner process's
 * own pid, not the harness's (the harness's pid lands in <outDir>/pid.txt,
 * written by the runner once it has spawned it).
 */
export function launchDetached({ argv, cwd, outDir, timeoutMs }) {
  mkdirSync(outDir, { recursive: true });
  const runnerArgs = [
    RUNNER_PATH,
    '--out',
    outDir,
    '--cwd',
    cwd,
    ...(timeoutMs !== undefined ? ['--timeout-ms', String(timeoutMs)] : []),
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
