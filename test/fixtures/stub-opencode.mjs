#!/usr/bin/env node
// Stub OpenCode harness for test/launch-real-path.test.mjs (review round 1,
// F2/F3). Ignores argv/stdin entirely - the test points opencode.mjs's
// buildArgv at this file via `config.adapters.opencode.cmd`/`argsPrefix`
// instead of the real `opencode` CLI. Prints already-normalized json lines
// to stdout with small delays (opencode.mjs's createStreamParser passes a
// recognized `type` straight through), then one line to stderr containing a
// fake GitHub PAT (so F3's redaction-at-rest can be asserted), then exits 0.

const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';

function ts() {
  return new Date().toISOString();
}

const lines = [
  { ts: ts(), type: 'session.start', session_id: 'oc_stub_1', model: 'opencode/stub-model' },
  { ts: ts(), type: 'tool.call', tool: 'bash', args_summary: 'command=ls' },
  { ts: ts(), type: 'tool.result', tool: 'bash', ok: true },
  { ts: ts(), type: 'message', role: 'assistant', tokens_in: 400, tokens_out: 90, cost_usd: 0.0025 },
  { ts: ts(), type: 'session.end', session_id: 'oc_stub_1', exit_code: 0, tokens_in: 400, tokens_out: 90, cost_usd: 0.0025, requests: 1 },
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
