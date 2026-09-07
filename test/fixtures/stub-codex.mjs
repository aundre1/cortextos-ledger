#!/usr/bin/env node
// Stub Codex CLI harness for test/launch-real-path.test.mjs (review round 1,
// F2/F3). Ignores argv/stdin entirely - the test points codex.mjs's
// buildArgv at this file via `config.adapters.codex.cmd`/`argsPrefix`
// instead of the real `codex` CLI. Prints a realistic `exec --json` NDJSON
// sequence to stdout with small delays, then one line to stderr containing a
// fake GitHub PAT (so F3's redaction-at-rest can be asserted), then exits 0.

const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';

const lines = [
  { type: 'thread.started', thread_id: 'thread_stub_codex' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls -la' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls -la', exit_code: 0, aggregated_output: 'README.md\n' } },
  { type: 'turn.completed', usage: { input_tokens: 300, output_tokens: 60 } },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  for (const line of lines) {
    process.stdout.write(`${JSON.stringify(line)}\n`);
    await sleep(15);
  }
  process.stderr.write(`warning: leaked token ${SECRET} while posting telemetry\n`);
  process.exitCode = 0;
}

main();
