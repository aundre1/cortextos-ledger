#!/usr/bin/env node
// Stub Claude Code harness for test/launch-real-path.test.mjs (review round
// 1, F2/F3). Ignores argv/stdin entirely - the test points claude.mjs's
// buildArgv at this file via `config.adapters.claude.cmd`/`argsPrefix`
// instead of the real `claude` CLI. Prints a realistic
// `--output-format stream-json` sequence to stdout with small delays (so
// runner.mjs's line-by-line tee sees more than one chunk), then one line to
// stderr containing a fake GitHub PAT (so F3's redaction-at-rest can be
// asserted), then exits 0.

const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';

const lines = [
  { type: 'system', subtype: 'init', session_id: 'sess_stub_claude', model: 'claude-stub' },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'src/x.mjs' } }],
      usage: { input_tokens: 500, output_tokens: 80 },
    },
    session_id: 'sess_stub_claude',
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] },
    session_id: 'sess_stub_claude',
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1200,
    num_turns: 2,
    result: 'stub run complete',
    session_id: 'sess_stub_claude',
    total_cost_usd: 0.0412,
    usage: { input_tokens: 580, output_tokens: 90 },
  },
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
