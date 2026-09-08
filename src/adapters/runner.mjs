#!/usr/bin/env node
// Standalone detached runner (docs/adapters.md "spawn helper and credential
// boundary", Fable arbitration 2026-09-07: "runner.mjs is a detached wrapper
// process that spawns the harness as its own child and writes exit.txt,
// elapsed_ms.txt, done.marker on close"). Invoked as its own child process,
// never imported:
//
//   node src/adapters/runner.mjs --out <dir> --cwd <dir> [--timeout-ms <n>]
//     [--adapter <name>] [--events <path>] -- <cmd> [args...]
//
// Review round 1 (F2/F3/F5) rewrote this from a raw stdout/stderr-to-fd
// redirect into a line-by-line tee, because a raw fd redirect can neither
// redact secrets nor feed a stream parser:
//
//   - Every line of the child's stdout AND stderr is redacted
//     (src/adapters/credential-boundary.mjs) and appended to <out>/out.txt
//     as it arrives (fs.appendFileSync per line, so the watchdog's
//     mtime-based stall check - src/guards/watchdog.mjs - sees real
//     progress instead of one write at the very end). F3.
//   - When --adapter names a module under this directory that exports
//     createStreamParser() (an object with push(line) -> events[] and
//     flush() -> events[]), each raw stdout line - fed to the parser
//     *before* redaction, so it still sees valid JSON - is turned into zero
//     or more normalized events, appended to --events live. stderr lines
//     never reach the parser (docs/adapters.md's normalized event format is
//     built from the harness's structured stdout only). F2.
//   - If the child closes without the parser ever emitting a session.end
//     event, one is synthesized with the real exit code and elapsed time,
//     so `ingest` never sees a run silently missing its end marker.
//   - exit.txt is written only if it does not already exist: the watchdog
//     (src/guards/watchdog.mjs) may have already written 137 there after
//     killing the process tree, and that value must win over whatever this
//     runner's own child.on('close') sees afterwards (the killed child's own
//     exit code/signal, which is not the wall-clock/stall reason). F5.
//
// A wedged command is killed as a process tree: `taskkill /PID <pid> /T /F`
// on Windows, `process.kill(-pid, 'SIGKILL')` (falling back to a plain kill)
// elsewhere - which only works because the command is spawned with
// `detached: true` on POSIX so it owns its own process group.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './credential-boundary.mjs';
import { ADAPTER_NAMES } from './index.mjs';
import { normalizeExitCode } from '../exit-code.mjs';

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

/**
 * exit.txt is written once, first writer wins (F5: the watchdog's kill exit
 * code must never be overwritten by this runner's own later observation).
 * `exitCode` is normalized (F3, src/exit-code.mjs) before it ever reaches
 * disk - a Windows-native unsigned exit code (4294967295 for a native -1)
 * must never enter the ledger as-is.
 */
function writeExitCodeOnce(outDir, exitCode) {
  const path = join(outDir, 'exit.txt');
  if (!existsSync(path)) writeFileSync(path, String(normalizeExitCode(exitCode)));
}

function writeDone(outDir, exitCode, elapsedMs) {
  writeExitCodeOnce(outDir, exitCode);
  writeFileSync(join(outDir, 'elapsed_ms.txt'), String(elapsedMs));
  writeFileSync(join(outDir, 'done.marker'), '');
}

/**
 * Only ever imports one of the fixed adapter modules this kit ships
 * (src/adapters/index.mjs's own allowlist) - never an arbitrary `--adapter`
 * value - dynamically, so a bad/attacker-controlled flag can never make this
 * process import an unintended file. Returns null (tee out.txt only, no
 * events.jsonl) when no adapter is named, the name is not on the allowlist,
 * or the module has no createStreamParser(). `cwd` (this run's own worktree,
 * already known to `main()` below) is forwarded to every adapter's
 * `createStreamParser({cwd})` so a tool call's own absolute-path input never
 * reaches `args_summary`/`error` on disk verbatim (`relativizeToCwd`,
 * `src/adapters/credential-boundary.mjs`) - a real run's `events.jsonl`
 * captured the operator's own `D:\...` worktree path this way. Every
 * adapter's `createStreamParser` treats a missing/undefined `cwd` as a
 * no-op, so this is safe even for a module that predates this parameter.
 */
async function loadParser(adapterName, cwd) {
  if (!adapterName || !ADAPTER_NAMES.includes(adapterName)) return null;
  try {
    const mod = await import(`./${adapterName}.mjs`);
    if (typeof mod.createStreamParser === 'function') return mod.createStreamParser({ cwd });
  } catch {
    // no parser available - still tee stdout/stderr to out.txt below
  }
  return null;
}

/** Feeds complete '\n'-delimited lines to `onLine`; keeps a partial last line buffered until the next chunk or flush(). Binary safe: chunks are decoded as utf8 text, same as every adapter's own stdout handling. */
function makeLineSplitter(onLine) {
  let buffer = '';
  return {
    write(chunk) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer.length) {
        onLine(buffer);
        buffer = '';
      }
    },
  };
}

async function main() {
  const { flags, cmd, args } = parseArgs(process.argv.slice(2));
  const outDir = flags.out;
  const cwd = flags.cwd ?? process.cwd();
  const timeoutMs = flags['timeout-ms'] !== undefined ? Number(flags['timeout-ms']) : undefined;
  const adapterName = flags.adapter;
  const eventsPath = flags.events;
  // Blocker 1 (src/adapters/prompt-delivery.mjs, src/adapters/spawn.mjs
  // launchDetached's `stdinFile`): a short path naming a file the caller
  // already wrote (redacted at rest, same as out.txt) whose exact bytes this
  // runner pipes onto the harness's own real stdin - never the prompt text
  // itself, which never reaches this runner's own argv.
  const stdinFilePath = flags['stdin-file'];
  // D1: events already known before the harness spawns (opencode's
  // `credentials.forwarded`/`credentials.missing`) - see spawn.mjs
  // launchDetached's `initialEvents` doc comment for why this must be seeded
  // here, right after this run's own fresh-per-run truncation below, rather
  // than by whichever caller built argv for this runner.
  let initialEvents = [];
  if (flags['initial-events']) {
    try {
      const parsed = JSON.parse(flags['initial-events']);
      if (Array.isArray(parsed)) initialEvents = parsed;
    } catch {
      // malformed --initial-events: never let this break the actual launch
    }
  }

  if (!outDir || !cmd) {
    process.stderr.write(
      'runner: usage: --out <dir> --cwd <dir> [--timeout-ms <n>] [--adapter <name>] [--events <path>] [--initial-events <json>] [--stdin-file <path>] -- <cmd> [args...]\n'
    );
    process.exit(1);
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'out.txt');
  // Fresh per run, same as every adapter's own (batch) writeFileSync of
  // out.txt/events.jsonl at close - this out dir is reused across retries of
  // the same agent on the same task (docs/architecture.md's runtime layout
  // is <runs>/<task>/<agent>/, not per run), so a prior attempt's leftover
  // content must not bleed into this one.
  writeFileSync(outPath, '');
  if (eventsPath) writeFileSync(eventsPath, '');

  const parser = await loadParser(adapterName, cwd);
  let sawSessionEnd = false;
  // The most recently appended session.end event object, kept around so
  // `finish()` below can tell whether it already carries the *real*
  // exit_code/elapsed_ms - not just whether one exists at all. Every
  // adapter's own createStreamParser() can emit a session.end mid-stream
  // (claude's final `result` line, codex's `turn.completed`, opencode's
  // synthesized end-of-stream one) well before this runner's own child
  // actually closes and the true exit code/elapsed time are known, and none
  // of the three reports both fields correctly on its own: claude's carries
  // a real exit_code but a `duration_ms` field, never `elapsed_ms`; codex's
  // `turn.completed` session.end carries neither; opencode's raw-stream
  // fallback (docs/adapters.md "opencode: parsing the real run --format
  // json stream") explicitly reports both as `null`, deferring to the real
  // process on purpose. Previously this runner treated "a session.end was
  // already seen" as "nothing more to do", so none of the three ever got a
  // corrected value once `sawSessionEnd` flipped true - see CHANGELOG.md
  // "runner: patch the real exit_code/elapsed_ms onto session.end".
  let lastSessionEndEvent = null;

  function appendOut(rawLine) {
    appendFileSync(outPath, `${redact(rawLine)}\n`);
  }

  function appendEvents(events) {
    if (!eventsPath || !events || !events.length) return;
    let text = '';
    for (const event of events) {
      if (event && event.type === 'session.end') {
        sawSessionEnd = true;
        lastSessionEndEvent = event;
      }
      text += `${JSON.stringify(event)}\n`;
    }
    if (text) appendFileSync(eventsPath, text);
  }

  // Seeded immediately after the truncation above and before the child ever
  // spawns, so these events are always first in the file regardless of how
  // quickly the harness starts writing its own.
  if (initialEvents.length) appendEvents(initialEvents);

  const stdoutSplitter = makeLineSplitter((line) => {
    appendOut(line);
    if (parser) {
      try {
        appendEvents(parser.push(line));
      } catch {
        // a parser bug must never take the harness or this runner down
      }
    }
  });
  const stderrSplitter = makeLineSplitter((line) => {
    // stderr never reaches the parser (docs/adapters.md's normalized event
    // format comes from the harness's structured stdout only) - out.txt
    // only, still redacted.
    appendOut(line);
  });

  const startedAt = Date.now();

  function finish(rawExitCode) {
    const exitCode = normalizeExitCode(rawExitCode);
    const elapsedMs = Date.now() - startedAt;
    if (parser && eventsPath) {
      if (!sawSessionEnd) {
        // No adapter ever reported a session.end at all - the pre-existing
        // fallback, unchanged.
        appendEvents([{ ts: new Date().toISOString(), type: 'session.end', exit_code: exitCode, elapsed_ms: elapsedMs }]);
      } else if (lastSessionEndEvent.exit_code !== exitCode || lastSessionEndEvent.elapsed_ms !== elapsedMs) {
        // A session.end was already written, but it does not carry the real
        // spawned process's exit code and elapsed time (missing, null, or a
        // harness-reported value that disagrees with what this runner
        // itself just observed) - append one more, corrected line rather
        // than rewriting the one already on disk (events.jsonl is append
        // only everywhere else in this kit). `ingest`/any other consumer
        // that wants "the" session.end already takes the *last* line of
        // this type in the file, so this corrected line is the one that
        // wins, while every other field the original event carried (tokens,
        // cost, session_id, unparsed_lines, ...) is preserved.
        appendEvents([{ ...lastSessionEndEvent, ts: new Date().toISOString(), exit_code: exitCode, elapsed_ms: elapsedMs }]);
      }
    }
    writeDone(outDir, exitCode, elapsedMs);
    process.exit(0);
  }

  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      stdio: [stdinFilePath ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
  } catch (e) {
    appendOut(`runner: spawn error: ${e.message}`);
    finish(1);
    return;
  }

  writeFileSync(join(outDir, 'pid.txt'), String(child.pid));

  // Blocker 1: write the relayed prompt file's exact bytes to the harness's
  // real stdin, then close it - an open, never-closed stdin is exactly what
  // docs/adapters.md's codex section warns hangs that harness, so this must
  // always end() once the write completes, never left open waiting for more.
  if (stdinFilePath) {
    try {
      child.stdin.write(readFileSync(stdinFilePath));
    } finally {
      child.stdin.end();
    }
  }

  child.stdout.on('data', (d) => stdoutSplitter.write(d));
  child.stderr.on('data', (d) => stderrSplitter.write(d));

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
    appendOut(`runner: process error: ${e.message}`);
    finish(1);
  });

  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    stdoutSplitter.flush();
    stderrSplitter.flush();
    if (parser) {
      try {
        appendEvents(parser.flush());
      } catch {
        // ignore - a parser bug must never take this runner down
      }
    }
    finish(timedOut ? 137 : code ?? 1);
  });
}

main();
