#!/usr/bin/env node
// Stub for test/opencode-isolation.test.mjs's dataHome test only (review
// round 1, F4): writes the XDG_DATA_HOME (and LOCALAPPDATA, for
// completeness on win32) this process was actually spawned with to the file
// named by CORTEX_TEST_DATAHOME_OUT in its env, so the test can assert
// run:launch computed `dataHome = join(config.runs, '.opencode-data',
// agent)` and threaded it through opencode.mjs's buildArgv rather than only
// unit-testing buildArgv in isolation. Then prints a minimal normalized
// session.start/session.end pair so run:launch's own flow (done.marker,
// events.jsonl) stays happy, and exits 0.

import { writeFileSync } from 'node:fs';

const outPath = process.env.CORTEX_TEST_DATAHOME_OUT;
if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify({
      XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? null,
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? null,
    })
  );
}

process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), type: 'session.start', session_id: 'oc_datahome' })}\n`);
process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), type: 'session.end', session_id: 'oc_datahome', exit_code: 0 })}\n`);
process.exitCode = 0;
