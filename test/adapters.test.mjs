import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as claude from '../src/adapters/claude.mjs';
import * as codex from '../src/adapters/codex.mjs';
import * as opencode from '../src/adapters/opencode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

function readFixtureLines(name) {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n');
}

function assertNoEventFieldTooLong(events, field, max = 200) {
  for (const event of events) {
    if (typeof event[field] === 'string') {
      assert.ok(event[field].length <= max, `${field} on ${event.type} exceeds ${max} chars: ${event[field]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

test('claude buildArgv: exact shape per docs/adapters.md', () => {
  const { cmd, args, env } = claude.buildArgv({
    prompt: 'do the thing',
    cwd: '/work',
    model: 'claude-opus-5',
    allowedTools: ['Read', 'Bash'],
    auth: 'subscription',
  });
  assert.equal(cmd, 'claude');
  assert.deepEqual(args, [
    '-p', 'do the thing',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-opus-5',
    '--allowedTools', 'Read,Bash',
  ]);
  assert.equal('ANTHROPIC_API_KEY' in env, false, 'subscription auth strips ANTHROPIC_API_KEY');
});

test('claude buildArgv: omits --model and --allowedTools when absent', () => {
  const { args } = claude.buildArgv({ prompt: 'hi', cwd: '/work' });
  assert.deepEqual(args, ['-p', 'hi', '--output-format', 'stream-json', '--verbose']);
});

test('claude buildArgv: auth "api" keeps ANTHROPIC_API_KEY via the credential boundary', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    const { env } = claude.buildArgv({ prompt: 'hi', cwd: '/work', auth: 'api' });
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('claude parseStream: fixture gives expected counts, tokens, cost, session id', () => {
  const events = claude.parseStream(readFixtureLines('claude-stream.jsonl'));

  const byType = (t) => events.filter((e) => e.type === t);
  assert.equal(byType('session.start').length, 1);
  assert.equal(byType('session.start')[0].session_id, 'sess_abc123');

  // tool_use: Read, Bash, plus one extra tool.call for the parent_tool_use_id
  // subagent message (docs/adapters.md: "count them as tool calls").
  assert.equal(byType('tool.call').length, 3);
  assert.equal(byType('tool.result').length, 2);
  const failedResult = byType('tool.result').find((e) => e.ok === false);
  assert.ok(failedResult, 'the failing tool_result should be present');
  assert.equal(byType('tool.result').find((e) => e.ok === true).tool, 'Read');
  assert.equal(failedResult.tool, 'Bash');

  // 4 assistant messages carry usage: msg_1, msg_2, msg_sub1, msg_3.
  assert.equal(byType('message').length, 4);

  const end = byType('session.end')[0];
  assert.equal(end.session_id, 'sess_abc123');
  assert.equal(end.tokens_in, 1550);
  assert.equal(end.tokens_out, 250);
  assert.equal(end.cost_usd, 0.0412);
  assert.equal(end.requests, 4);
  assert.equal(end.exit_code, 0);

  assertNoEventFieldTooLong(events, 'args_summary');
  assertNoEventFieldTooLong(events, 'error');
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

test('codex buildArgv: new run, default sandbox read-only for reviewer roles', () => {
  const { cmd, args } = codex.buildArgv({ prompt: 'review this', cwd: '/work', readOnly: true, outDir: '/out' });
  assert.equal(cmd, 'codex');
  assert.deepEqual(args, ['exec', '--json', '--sandbox', 'read-only', '--cd', '/work', '-o', join('/out', 'last-message.md'), 'review this']);
});

test('codex buildArgv: default sandbox workspace-write for builder roles', () => {
  const { args } = codex.buildArgv({ prompt: 'build this', cwd: '/work', outDir: '/out' });
  assert.ok(args.includes('workspace-write'));
});

test('codex buildArgv: resume passes -c sandbox_mode="read-only" and no --sandbox', () => {
  const { args } = codex.buildArgv({ prompt: 'continue', cwd: '/work', outDir: '/out', resumeThreadId: 'thread_123' });
  assert.deepEqual(args, [
    'exec', 'resume', 'thread_123',
    '-c', 'sandbox_mode="read-only"',
    '--json', '-o', join('/out', 'last-message.md'),
    'continue',
  ]);
  assert.equal(args.includes('--sandbox'), false);
});

test('codex buildArgv: danger-full-access is refused with exit code 1', () => {
  assert.throws(
    () => codex.buildArgv({ prompt: 'x', cwd: '/work', outDir: '/out', sandbox: 'danger-full-access' }),
    (e) => e instanceof Error && e.code === 1
  );
});

test('codex parseStream: fixture gives expected session id, tool counts, usage', () => {
  const events = codex.parseStream(readFixtureLines('codex-exec.jsonl'));
  const byType = (t) => events.filter((e) => e.type === t);

  assert.equal(byType('session.start')[0].session_id, 'thread_9f8e7d');
  assert.equal(byType('tool.call').length, 2);
  assert.equal(byType('tool.result').length, 2);
  const ok = byType('tool.result').find((e) => e.ok === true);
  const fail = byType('tool.result').find((e) => e.ok === false);
  assert.equal(ok.tool, 'command_execution');
  assert.equal(fail.tool, 'file_change');
  assert.equal(fail.error, 'permission denied');

  assert.equal(byType('session.end').length, 1);
  const end = byType('session.end')[0];
  assert.equal(end.tokens_in, 1200);
  assert.equal(end.tokens_out, 340);
  assert.equal(end.usage_source, 'reported');

  assertNoEventFieldTooLong(events, 'args_summary');
  assertNoEventFieldTooLong(events, 'error');
});

test('codex parseStream: missing turn.completed usage synthesizes a zeroed session.end with source manual', () => {
  const events = codex.parseStream(['{"type":"thread.started","thread_id":"t1"}']);
  const end = events.find((e) => e.type === 'session.end');
  assert.ok(end);
  assert.equal(end.tokens_in, 0);
  assert.equal(end.tokens_out, 0);
  assert.equal(end.usage_source, 'manual');
});

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

test('opencode buildArgv: refuses an anthropic/claude model with exit code 1', () => {
  assert.throws(
    () => opencode.buildArgv({ prompt: 'x', cwd: '/work', model: 'anthropic/claude-x' }),
    (e) => e instanceof Error && e.code === 1
  );
});

test('opencode buildArgv: shape, agent + model flags, data home isolation', () => {
  const { cmd, args, env } = opencode.buildArgv({
    prompt: 'build the thing',
    cwd: '/work',
    agent: 'builder',
    model: 'opencode/deepseek-v4',
    dataHome: '/data',
    outDir: '/out',
  });
  assert.equal(cmd, 'opencode');
  assert.deepEqual(args, ['run', '--agent', 'builder', '--model', 'opencode/deepseek-v4', '--format', 'json', 'build the thing']);
  assert.equal(env.XDG_DATA_HOME, join('/data', 'builder'));
  assert.equal(env.CORTEX_EVENTS_PATH, join('/out', 'events.jsonl'));
});

test('opencode buildArgv: omits --agent/--model when absent', () => {
  const { args } = opencode.buildArgv({ prompt: 'go', cwd: '/work' });
  assert.deepEqual(args, ['run', '--format', 'json', 'go']);
});

test('opencode parseStream: fixture (already-normalized plugin events) gives expected counts and redacts secrets', () => {
  const events = opencode.parseStream(readFixtureLines('opencode-events.jsonl'));
  const byType = (t) => events.filter((e) => e.type === t);

  assert.equal(byType('session.start')[0].session_id, 'oc_session_1');
  assert.equal(byType('tool.call').length, 2);
  assert.equal(byType('tool.result').length, 2);

  const failed = byType('tool.result').find((e) => e.ok === false);
  assert.ok(failed, 'the failing tool.result should be present');
  assert.equal(failed.error.includes('[REDACTED]'), true, 'the ghp_ token must be redacted');
  assert.equal(failed.error.includes('ghp_'), false, 'the raw token must not survive parseStream');

  assert.equal(byType('message').length, 1);
  assert.equal(byType('message')[0].cost_usd, 0.0031);

  const end = byType('session.end')[0];
  assert.equal(end.session_id, 'oc_session_1');
  assert.equal(end.tokens_in, 900);
  assert.equal(end.tokens_out, 210);
  assert.equal(end.cost_usd, 0.0031);
  assert.equal(end.requests, 1);

  assertNoEventFieldTooLong(events, 'args_summary');
  assertNoEventFieldTooLong(events, 'error');
});
