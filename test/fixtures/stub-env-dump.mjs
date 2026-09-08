#!/usr/bin/env node
// Stub harness for the Codex round F1 regression test (test/spawn-env.test.mjs).
// Ignores argv/stdin entirely; writes every environment variable it actually
// received to <outDir-relative path passed as argv[2]> as JSON, then prints
// one realistic session.start/session.end pair so the normal run:launch path
// (events.jsonl, done.marker) still completes the way every other stub does.

import { writeFileSync } from 'node:fs';

// Read from an env var, not argv[2]: config.adapters.<name>.argsPrefix
// prepends this script's path ahead of each adapter's own real args (the
// prompt, --model, etc.), so argv[2] is adapter-specific, not this path.
// CORTEX_TEST_ENV_DUMP_PATH matches none of credential-boundary.mjs's strip
// patterns, so it survives filterEnv and reaches this process unchanged.
const dumpPath = process.env.CORTEX_TEST_ENV_DUMP_PATH;
if (dumpPath) {
  writeFileSync(dumpPath, JSON.stringify(process.env));
}

const lines = [
  { type: 'session.start', session_id: 'sess_env_dump' },
  { type: 'session.end', session_id: 'sess_env_dump', exit_code: 0, tokens_in: 1, tokens_out: 1 },
];
for (const line of lines) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
process.exitCode = 0;
