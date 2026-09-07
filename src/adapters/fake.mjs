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
//   }
//
// The fixture comes from opts.fixture directly, or - when opts.fixture is
// not given - is read as JSON from the file at opts.env.CORTEX_FAKE_FIXTURE.
// With neither, an empty fixture (a trivial, instantly successful run) is
// used.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';

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

  writeFileSync(join(outDir, 'out.txt'), fixture.out ?? '');
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
  };
}
