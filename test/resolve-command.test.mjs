// Windows command resolution (docs/adapters.md "Windows command
// resolution"): src/adapters/resolve-command.mjs. Every case below injects
// `platform: 'win32'` explicitly, so these run and prove the Windows
// resolution logic on any host, including this Linux workspace - only real
// filesystem checks (fs.existsSync against scratch files this test creates)
// are not injected, since resolveCommand's own contract only makes
// `platform`/`env`/`execPath`/`readFile` overridable.
//
// Shim text fixtures below are quoted verbatim from real npm-generated
// `.cmd` shims (the exact lines this wave's task card supplied, reproduced
// from a real Windows machine's npm-installed harnesses) - written into
// scratch files here, never into a committed fixture, and using only
// `%dp0%`-relative forms (no personal path ever appears).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTempDir } from './helpers.mjs';
import { resolveCommand, resolveConfiguredCommand, applyResolvedCommand, escapeCmdArg } from '../src/adapters/resolve-command.mjs';

function writeFile(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content ?? '');
  return p;
}

function writeNested(dir, relSegments, content) {
  const full = join(dir, ...relSegments);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content ?? '');
  return full;
}

// ---------------------------------------------------------------------------
// escapeCmdArg
// ---------------------------------------------------------------------------

test('escapeCmdArg: exact escaped string for an arg with a space, a double quote, a percent, and an ampersand', () => {
  const input = 'foo bar"baz%qux&quux';
  // step 1: `"` -> `\"` (no preceding backslashes to double here)
  // step 3: wrap in quotes -> "foo bar\"baz%qux&quux"
  // step 4: escape cmd metachars ()%!^"<>&| with a leading ^, including the
  // quote characters the earlier steps introduced
  assert.equal(escapeCmdArg(input), '^"foo bar\\^"baz^%qux^&quux^"');
});

test('escapeCmdArg: backslashes immediately before a quote are doubled', () => {
  // one backslash before the quote -> doubled to two, plus the escaped quote
  assert.equal(escapeCmdArg('a\\"b'), '^"a\\\\\\^"b^"');
});

test('escapeCmdArg: trailing backslashes are doubled so they do not escape the closing quote', () => {
  assert.equal(escapeCmdArg('a\\'), '^"a\\\\^"');
});

test('escapeCmdArg: a plain argument with no special characters is only quoted', () => {
  assert.equal(escapeCmdArg('plain'), '^"plain^"');
});

// ---------------------------------------------------------------------------
// resolveCommand
// ---------------------------------------------------------------------------

test('resolveCommand: non-win32 platform passes the name through unchanged (POSIX passthrough)', () => {
  const result = resolveCommand('claude', { platform: 'linux' });
  assert.deepEqual(result, { cmd: 'claude', prefixArgs: [], resolvedFrom: 'posix' });
});

test('resolveCommand: win32, an .exe later on PATH beats a .cmd earlier on PATH', () => {
  const earlierDir = makeTempDir();
  const laterDir = makeTempDir();
  // A .cmd shim sits in the earlier PATH entry - deliberately unparseable
  // (irrelevant content), to prove it is never even inspected: the whole
  // exe/com pass across every PATH entry runs first, before any .cmd is
  // looked at (rule c beats rule d regardless of PATH order).
  writeFile(earlierDir, 'claude.cmd', '@echo off\r\necho not the real claude\r\n');
  const exePath = writeFile(laterDir, 'claude.exe', '');

  const env = { PATH: `${earlierDir};${laterDir}` };
  const result = resolveCommand('claude', { platform: 'win32', env });
  assert.equal(result.cmd, exePath);
  assert.deepEqual(result.prefixArgs, []);
  assert.equal(result.resolvedFrom, 'exe on PATH');
});

test('resolveCommand: win32, a direct-exe npm shim resolves to the real node_modules exe', () => {
  const dir = makeTempDir();
  // Real npm cmd-shim text for a package whose bin is itself a native/pkg
  // executable (this wave's reference opencode.cmd shape).
  writeFile(
    dir,
    'opencode.cmd',
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /B',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      '',
    ].join('\r\n')
  );
  const exePath = writeNested(dir, ['node_modules', 'opencode-ai', 'bin', 'opencode.exe']);

  const result = resolveCommand('opencode', { platform: 'win32', env: { PATH: dir } });
  assert.equal(result.cmd, exePath);
  assert.deepEqual(result.prefixArgs, []);
  assert.equal(result.resolvedFrom, 'npm shim -> exe');
});

test('resolveCommand: win32, a node-launcher npm shim resolves to execPath + the real .js', () => {
  const dir = makeTempDir();
  // Real npm cmd-shim text for a package whose bin is a plain JS file (this
  // wave's reference codex.cmd shape - note the @-scoped package segment).
  writeFile(
    dir,
    'codex.cmd',
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /B',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      '',
    ].join('\r\n')
  );
  const jsPath = writeNested(dir, ['node_modules', '@openai', 'codex', 'bin', 'codex.js']);

  const fakeExecPath = 'C:\\fake\\nodejs\\node.exe';
  const result = resolveCommand('codex', { platform: 'win32', env: { PATH: dir }, execPath: fakeExecPath });
  assert.equal(result.cmd, fakeExecPath);
  assert.deepEqual(result.prefixArgs, [jsPath]);
  assert.equal(result.resolvedFrom, 'npm shim -> node + js');
});

test('resolveCommand: win32, npm.cmd\'s own real shim shape resolves to execPath + npm-cli.js', () => {
  const dir = makeTempDir();
  // The exact line this wave's task card quoted for npm.cmd itself.
  writeFile(dir, 'npm.cmd', '"%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
  const jsPath = writeNested(dir, ['node_modules', 'npm', 'bin', 'npm-cli.js']);

  const fakeExecPath = 'C:\\fake\\nodejs\\node.exe';
  const result = resolveCommand('npm', { platform: 'win32', env: { PATH: dir }, execPath: fakeExecPath });
  assert.equal(result.cmd, fakeExecPath);
  assert.deepEqual(result.prefixArgs, [jsPath]);
  assert.equal(result.resolvedFrom, 'npm shim -> node + js');
});

test('resolveCommand: win32, a shim whose parsed target does not exist on disk falls through to the cmd.exe fallback', () => {
  const dir = makeTempDir();
  const cmdPath = writeFile(
    dir,
    'ghost.cmd',
    '"%dp0%\\node_modules\\ghost-pkg\\bin\\ghost.exe"   %*\r\n'
  );
  // Deliberately never create node_modules/ghost-pkg/bin/ghost.exe.

  const result = resolveCommand('ghost', { platform: 'win32', env: { PATH: dir, ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.equal(result.resolvedFrom, 'cmd.exe fallback');
  assert.equal(result.cmd, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(result.prefixArgs, ['/d', '/s', '/c', escapeCmdArg(cmdPath)]);
  assert.equal(result.escapeArgs, true);
});

test('resolveCommand: win32, an unparseable .cmd falls back to cmd.exe with correctly escaped args', () => {
  const dir = makeTempDir();
  const cmdPath = writeFile(dir, 'weird.cmd', '@echo off\r\nrem this shim does not match either known npm shape\r\necho hi\r\n');

  const result = resolveCommand('weird', { platform: 'win32', env: { PATH: dir, ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.equal(result.resolvedFrom, 'cmd.exe fallback');
  assert.equal(result.escapeArgs, true);

  const built = applyResolvedCommand(result, ['run', 'a value with spaces', 'a"quote', '50%', 'a&b']);
  assert.equal(built.cmd, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(built.args, [
    '/d', '/s', '/c', escapeCmdArg(cmdPath),
    escapeCmdArg('run'),
    escapeCmdArg('a value with spaces'),
    escapeCmdArg('a"quote'),
    escapeCmdArg('50%'),
    escapeCmdArg('a&b'),
  ]);
  // Exact strings, not just "escapeCmdArg applied again" (which would be
  // tautological) - the space/quote/percent/ampersand case is asserted
  // literally in the escapeCmdArg tests above; here just confirm each
  // escaped arg is individually quoted, e.g. never bare.
  for (const a of built.args.slice(4)) {
    assert.ok(a.startsWith('^"') || a.startsWith('"'), `expected a quoted arg, got ${a}`);
  }
});

test('resolveCommand: win32, nothing on PATH at all - resolvedFrom is null (rule f)', () => {
  const emptyDir = makeTempDir();
  const result = resolveCommand('totally-not-a-real-tool', { platform: 'win32', env: { PATH: emptyDir } });
  assert.deepEqual(result, { cmd: 'totally-not-a-real-tool', prefixArgs: [], resolvedFrom: null });
});

test('resolveCommand: win32, a name already ending in .exe is used as given', () => {
  const result = resolveCommand('C:\\tools\\gh.exe', { platform: 'win32', env: { PATH: '' } });
  assert.deepEqual(result, { cmd: 'C:\\tools\\gh.exe', prefixArgs: [], resolvedFrom: 'given' });
});

// ---------------------------------------------------------------------------
// resolveConfiguredCommand precedence (docs/adapters.md "Windows command
// resolution": explicit cmd > config.tools > resolveCommand)
// ---------------------------------------------------------------------------

test('resolveConfiguredCommand: an explicit cmd wins outright, even with a toolOverride also set', () => {
  const result = resolveConfiguredCommand('claude', { cmd: '/stub/claude', toolOverride: ['/other/claude'] });
  assert.deepEqual(result, { cmd: '/stub/claude', prefixArgs: [], resolvedFrom: 'override' });
});

test('resolveConfiguredCommand: a toolOverride skips resolveCommand entirely', () => {
  const result = resolveConfiguredCommand('gh', {
    toolOverride: ['C:/tools/gh.exe', '--some-flag'],
    platform: 'win32',
    env: { PATH: '' },
  });
  assert.deepEqual(result, { cmd: 'C:/tools/gh.exe', prefixArgs: ['--some-flag'], resolvedFrom: 'config.tools' });
});

test('resolveConfiguredCommand: with neither cmd nor toolOverride, falls through to resolveCommand', () => {
  const result = resolveConfiguredCommand('claude', { platform: 'linux' });
  assert.deepEqual(result, { cmd: 'claude', prefixArgs: [], resolvedFrom: 'posix' });
});

// ---------------------------------------------------------------------------
// applyResolvedCommand
// ---------------------------------------------------------------------------

test('applyResolvedCommand: a non-escaping resolution passes args through untouched', () => {
  const resolution = { cmd: '/real/claude', prefixArgs: [], resolvedFrom: 'exe on PATH' };
  const built = applyResolvedCommand(resolution, ['-p', 'hello world', '--model', 'x']);
  assert.deepEqual(built, { cmd: '/real/claude', args: ['-p', 'hello world', '--model', 'x'] });
});

test('applyResolvedCommand: node-launcher prefixArgs (the real .js path) come before the caller\'s own args', () => {
  const resolution = { cmd: '/fake/node', prefixArgs: ['/fake/node_modules/npm/bin/npm-cli.js'], resolvedFrom: 'npm shim -> node + js' };
  const built = applyResolvedCommand(resolution, ['pack', '--dry-run', '--json']);
  assert.deepEqual(built, { cmd: '/fake/node', args: ['/fake/node_modules/npm/bin/npm-cli.js', 'pack', '--dry-run', '--json'] });
});
