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
    const payload = {
      number: Number(args[2]),
      title: process.env.GH_STUB_TITLE ?? 'stub PR title',
      body: process.env.GH_STUB_BODY ?? 'stub PR body',
      baseRefOid: process.env.GH_STUB_BASE_SHA ?? 'base0000000000000000000000000000000000',
      headRefOid: process.env.GH_STUB_HEAD_SHA ?? 'head0000000000000000000000000000000000',
      baseRefName: process.env.GH_STUB_BASE_REF ?? 'main',
      headRefName: process.env.GH_STUB_HEAD_REF ?? 'feature',
    };
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
