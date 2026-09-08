#!/usr/bin/env node
// Stub `gh` executable for test/pr-capture.test.mjs. Copied onto disk as a
// file literally named `gh` (no extension) in a temp directory that is put
// first on the child cortexctl process's PATH, so task:new's real
// `spawnSync('gh', ...)` call (src/commands/tasks.mjs) resolves and executes
// this file for real - no monkey-patching of spawnSync, no mocked module.
//
// Controlled entirely through environment variables so one executable
// stands in for every scenario the test drives: happy path, a non-zero gh
// exit (either subcommand), and a diff too large to pass on the environment
// (GH_STUB_DIFF_FILE points at a file on disk instead of GH_STUB_DIFF, since
// environment variables have OS-level size limits well under the 2,000,000
// byte size guard this stub is used to exercise).
//
// Every exit happens from the write callback, not right after the write
// call: `process.stdout.write()` to a pipe is asynchronous, and calling
// `process.exit()` immediately after queuing a large write (over a pipe's
// ~64KB kernel buffer on Linux) truncates it - the parent (spawnSync in
// src/commands/tasks.mjs) would then see a short diff instead of the full
// one the size-guard test needs to actually exceed 2,000,000 bytes.
//
// GH_STUB_BODY_NUL_MARKER (review round 2, F5): an OS environment variable
// cannot itself carry an embedded NUL byte - it is transported as a
// NUL-terminated C string - so a test that needs `gh pr view`'s JSON body to
// contain a real NUL character mid-string cannot just put one in
// GH_STUB_BODY directly. Instead the test passes an ordinary marker
// substring (e.g. "<<NUL>>") inside GH_STUB_BODY and names that same marker
// in GH_STUB_BODY_NUL_MARKER; this stub swaps every occurrence of the
// marker for String.fromCharCode(0) - a real NUL character - in its own
// in-memory JS string, before JSON.stringify runs (JSON.stringify escapes a
// NUL to a six-character sequence in the JSON text it prints, and
// task:new's capturePr() JSON.parses that straight back into a JS string
// containing a real NUL character again) - exactly reproducing what a
// genuine embedded NUL in a PR body looks like by the time it reaches
// insertMessage.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);

function exitAfter(stream, data, exitCode) {
  stream.write(data, () => process.exit(exitCode));
}

function fail(exitCode, message) {
  exitAfter(process.stderr, `${message}\n`, exitCode);
}

if (args[0] === 'pr' && args[1] === 'view') {
  const exitCode = Number(process.env.GH_STUB_VIEW_EXIT || 0);
  if (exitCode !== 0) {
    fail(exitCode, process.env.GH_STUB_VIEW_STDERR || 'gh: pr view failed (stub)');
  } else {
    let body = process.env.GH_STUB_BODY ?? 'stub PR body';
    if (process.env.GH_STUB_BODY_NUL_MARKER) {
      body = body.split(process.env.GH_STUB_BODY_NUL_MARKER).join(String.fromCharCode(0));
    }
    const payload = {
      number: Number(args[2]),
      title: process.env.GH_STUB_TITLE ?? 'stub PR title',
      body,
      baseRefName: process.env.GH_STUB_BASE_REF ?? 'main',
      headRefName: process.env.GH_STUB_HEAD_REF ?? 'feature',
    };
    // GH_STUB_OMIT_SHAS simulates a real `gh pr view` response that omits
    // baseRefOid/headRefOid entirely (e.g. a PR with no computed merge base
    // yet) - task:new's capture must store null for these, not crash with a
    // TypeError reading a property off an object gh's JSON never gave it.
    if (process.env.GH_STUB_OMIT_SHAS !== '1') {
      payload.baseRefOid = process.env.GH_STUB_BASE_SHA ?? 'base0000000000000000000000000000000000';
      payload.headRefOid = process.env.GH_STUB_HEAD_SHA ?? 'head0000000000000000000000000000000000';
    }
    exitAfter(process.stdout, JSON.stringify(payload), 0);
  }
} else if (args[0] === 'pr' && args[1] === 'diff') {
  const exitCode = Number(process.env.GH_STUB_DIFF_EXIT || 0);
  if (exitCode !== 0) {
    fail(exitCode, process.env.GH_STUB_DIFF_STDERR || 'gh: pr diff failed (stub)');
  } else {
    const data = process.env.GH_STUB_DIFF_FILE
      ? readFileSync(process.env.GH_STUB_DIFF_FILE)
      : (process.env.GH_STUB_DIFF ?? 'diff --git a/x b/x\n');
    exitAfter(process.stdout, data, 0);
  }
} else {
  fail(127, `gh stub: unknown invocation: ${args.join(' ')}`);
}
