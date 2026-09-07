// Deterministic adapter for tests (docs/adapters.md "fake"). Same interface
// as every other adapter - run(opts) - driven by a fixture describing the
// events to emit, the files to write, the exit code, and the elapsed time,
// so every guard and limit can be proven without spending a token or
// spawning a real harness process.
//
// Fixture shape (all fields optional):
//   {
//     events: [ { ts, type, ... }, ... ],  // written one JSON object per line to events.jsonl
//     files: { "relative/path.txt": "contents", ... },  // written under cwd
//     out: "text",              // out.txt contents, default ""
//     exitCode: 0,              // exit.txt contents and the returned exitCode
//     elapsedMs: 0,             // elapsed_ms.txt contents
//     sessionId, tokensIn, tokensOut, costUsd, requests, toolCalls, summary
//     stdout_json: {...}      // docs/autonomy.md: when present, this object
//                              // (not `out`) becomes out.txt's only content,
//                              // JSON stringified, and is returned as
//                              // result.text - the loop's propose/review
//                              // steps read the model's JSON output this way
//                              // regardless of adapter.
//   }
//
// The fixture comes from opts.fixture directly, or - when opts.fixture is
// not given - is read as JSON from the file at opts.env.CORTEX_FAKE_FIXTURE.
// With neither, an empty fixture (a trivial, instantly successful run) is
// used.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_PATH = fileURLToPath(new URL('./fake-harness.mjs', import.meta.url));

/**
 * buildArgv({ cmd, argsPrefix }) -> { cmd, args, cwd, env } (review round 1,
 * F2): lets `run:launch`'s default (non `--sync`) path spawn the fake
 * adapter exactly like every real one - through
 * src/adapters/spawn.mjs's launchDetached() and src/adapters/runner.mjs's
 * tee - instead of only ever running in process. The spawned command is
 * this same node process re-invoked on src/adapters/fake-harness.mjs, which
 * reads the identical fixture format this file's own run() reads (from
 * `CORTEX_FAKE_FIXTURE` in the child's env, inherited from `process.env`
 * here) and prints each fixture event as one normalized JSON line to
 * stdout - createStreamParser() below passes those straight through.
 * `cmd`/`argsPrefix`, if given, override the executable/prepend args exactly
 * like the real adapters' buildArgv (unused by the fake harness itself, kept
 * only so callers that always forward `config.adapters.fake.*` do not need a
 * special case).
 */
export function buildArgv({ cwd, cmd, argsPrefix } = {}) {
  return {
    cmd: cmd ?? process.execPath,
    args: [...(argsPrefix ?? []), HARNESS_PATH],
    cwd,
    env: { ...process.env },
  };
}

/**
 * createStreamParser() -> { push(line) -> events[], flush() -> events[] }
 * (review round 1, F2): "pass through" (docs/adapters.md "fake") - the fake
 * harness already prints exactly this kit's normalized event shape, one per
 * line, so there is nothing to translate; a line that is not valid JSON is
 * simply not an event (e.g. `fixture.out` text mixed into the same stdout).
 */
export function createStreamParser() {
  return {
    push(raw) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) return [];
      try {
        return [JSON.parse(text)];
      } catch {
        return [];
      }
    },
    flush() {
      return [];
    },
  };
}

function loadFixture(opts) {
  if (opts.fixture) return opts.fixture;
  const path = opts.env && opts.env.CORTEX_FAKE_FIXTURE;
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  return {};
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeFileEnsuringDir(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

export async function run(opts) {
  const fixture = loadFixture(opts);
  const outDir = opts.outDir;
  const cwd = opts.cwd;
  const events = fixture.events ?? [];
  const exitCode = fixture.exitCode ?? 0;
  const elapsedMs = fixture.elapsedMs ?? 0;

  ensureDir(outDir);

  const eventsText = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  writeFileSync(join(outDir, 'events.jsonl'), eventsText);
  for (const event of events) {
    opts.onEvent?.(event);
  }

  const outText = fixture.stdout_json !== undefined ? JSON.stringify(fixture.stdout_json) : fixture.out ?? '';
  writeFileSync(join(outDir, 'out.txt'), outText);
  writeFileSync(join(outDir, 'exit.txt'), String(exitCode));
  writeFileSync(join(outDir, 'elapsed_ms.txt'), String(elapsedMs));
  writeFileSync(join(outDir, 'done.marker'), '');
  writeFileSync(join(outDir, 'pid.txt'), String(process.pid));

  if (fixture.files) {
    for (const [relativePath, content] of Object.entries(fixture.files)) {
      const dest = isAbsolute(relativePath) ? relativePath : join(cwd, relativePath);
      writeFileEnsuringDir(dest, content);
    }
  }

  if (opts.detach) {
    return { pid: process.pid };
  }

  return {
    pid: process.pid,
    exitCode,
    sessionId: fixture.sessionId ?? null,
    tokensIn: fixture.tokensIn ?? 0,
    tokensOut: fixture.tokensOut ?? 0,
    costUsd: fixture.costUsd ?? 0,
    requests: fixture.requests ?? 0,
    toolCalls: fixture.toolCalls ?? 0,
    summary: fixture.summary ?? '',
    text: outText,
  };
}
