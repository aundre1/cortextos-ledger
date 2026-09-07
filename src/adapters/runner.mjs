#!/usr/bin/env node
// Standalone detached runner (docs/adapters.md "spawn helper and credential
// boundary", Fable arbitration 2026-09-07: "runner.mjs is a detached wrapper
// process that spawns the harness as its own child and writes exit.txt,
// elapsed_ms.txt, done.marker on close"). Invoked as its own child process,
// never imported:
//
//   node src/adapters/runner.mjs --out <dir> --cwd <dir> [--timeout-ms <n>] -- <cmd> [args...]
//
// Writes pid.txt immediately after spawning the command, appends the
// command's stdout+stderr to <out>/out.txt, and on close (or on timeout)
// writes exit.txt, elapsed_ms.txt, done.marker. A wedged command is killed
// as a process tree: `taskkill /PID <pid> /T /F` on Windows,
// `process.kill(-pid, 'SIGKILL')` (falling back to a plain kill) elsewhere -
// which only works because the command is spawned with `detached: true` on
// POSIX so it owns its own process group.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const flags = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      i++;
      break;
    }
    if (token.startsWith('--')) {
      flags[token.slice(2)] = argv[i + 1];
      i++;
    }
  }
  const rest = argv.slice(i);
  return { flags, cmd: rest[0], args: rest.slice(1) };
}

function killTree(pid) {
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

function writeDone(outDir, exitCode, elapsedMs) {
  writeFileSync(join(outDir, 'exit.txt'), String(exitCode));
  writeFileSync(join(outDir, 'elapsed_ms.txt'), String(elapsedMs));
  writeFileSync(join(outDir, 'done.marker'), '');
}

function main() {
  const { flags, cmd, args } = parseArgs(process.argv.slice(2));
  const outDir = flags.out;
  const cwd = flags.cwd ?? process.cwd();
  const timeoutMs = flags['timeout-ms'] !== undefined ? Number(flags['timeout-ms']) : undefined;

  if (!outDir || !cmd) {
    process.stderr.write(
      'runner: usage: --out <dir> --cwd <dir> [--timeout-ms <n>] -- <cmd> [args...]\n'
    );
    process.exit(1);
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFd = openSync(join(outDir, 'out.txt'), 'a');

  const startedAt = Date.now();
  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', outFd, outFd],
      shell: false,
      detached: process.platform !== 'win32',
    });
  } catch (e) {
    closeSync(outFd);
    writeFileSync(join(outDir, 'out.txt'), `runner: spawn error: ${e.message}\n`, { flag: 'a' });
    writeDone(outDir, 1, Date.now() - startedAt);
    process.exit(0);
    return;
  }

  writeFileSync(join(outDir, 'pid.txt'), String(child.pid));

  let timedOut = false;
  let timer = null;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();
  }

  child.on('error', (e) => {
    if (timer) clearTimeout(timer);
    try {
      closeSync(outFd);
    } catch {
      // already closed by the child exiting
    }
    writeFileSync(join(outDir, 'out.txt'), `runner: process error: ${e.message}\n`, { flag: 'a' });
    writeDone(outDir, 1, Date.now() - startedAt);
    process.exit(0);
  });

  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    try {
      closeSync(outFd);
    } catch {
      // ignore
    }
    const elapsedMs = Date.now() - startedAt;
    const exitCode = timedOut ? 137 : code ?? 1;
    writeDone(outDir, exitCode, elapsedMs);
    process.exit(0);
  });
}

main();
