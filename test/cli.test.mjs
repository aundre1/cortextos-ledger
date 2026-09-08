// CLI dispatch itself (bin/cortexctl.mjs), as opposed to any one command's
// own behaviour: unknown command, `help`, and top level config/db failures.
// docs/state-machine.md's exit code table assigns 1 to "usage error, bad
// arguments, missing config" - this file is where "bad arguments" at the
// dispatch layer (before any command handler runs) gets covered, since
// every other test file exercises a specific command's own flag checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runCli, makeTempDb, makeTempDir } from './helpers.mjs';

test('cortexctl: an unknown command exits 1 with one stderr line naming it', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);

  const result = runCli(['not:a:real:command', '--db', dbPath]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.trim(), /^cortexctl: usage: unknown command: not:a:real:command$/);
  assert.equal(result.stdout, '');
});

test('cortexctl: no command at all prints help and exits 0', () => {
  const result = runCli([]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /cortexctl <command> \[--flags\]/);
  assert.match(result.stdout, /task:new/);
  assert.match(result.stdout, /purge/);
});

test('cortexctl: `help` lists every command from docs/cli.md, one line each', () => {
  const result = runCli(['help']);
  assert.equal(result.code, 0, result.stderr);
  const DOCUMENTED_COMMANDS = [
    'init', 'doctor', 'config:show', 'quota:set', 'quota:tick', 'quota:show',
    'task:new', 'task:show', 'task:close', 'task:resolve', 'task:reject', 'board',
    'task:archive', 'task:unarchive',
    'preflight', 'run:start', 'run:launch', 'run:end', 'watch', 'ingest', 'msg', 'artifact',
    'review:brief', 'verdict', 'adjudicate', 'triage:note',
    'test', 'intervene',
    'packet', 'compare', 'report', 'export', 'usage:snapshot', 'usage:delta', 'limits', 'purge',
  ];
  for (const name of DOCUMENTED_COMMANDS) {
    assert.match(result.stdout, new RegExp(`^  ${name.replace(':', '\\:')}\\s`, 'm'), `help output is missing ${name}`);
  }
});

test('cortexctl: a command missing its required flags exits 1 with reason usage', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);

  const result = runCli(['run:start', '--db', dbPath]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.trim(), /^cortexctl: usage: missing required flags: --task, --agent$/);
});

test('cortexctl: --config pointing at a missing file exits 1 before any command runs', () => {
  const result = runCli(['task:new', '--config', join(makeTempDir(), 'no-such-config.json'), '--repo', 'o/n']);
  assert.equal(result.code, 1);
  assert.match(result.stderr.trim(), /^cortexctl: config:/);
});
