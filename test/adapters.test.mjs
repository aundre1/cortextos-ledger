import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as claude from '../src/adapters/claude.mjs';
import * as codex from '../src/adapters/codex.mjs';
import * as opencode from '../src/adapters/opencode.mjs';
import { makeTempDir } from './helpers.mjs';

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

// buildArgv shape tests (cmd and/or args) inject `platform: 'linux'`
// (`platformOverride` for opencode - see its own buildArgv doc comment)
// explicitly, so they assert this kit's own argv construction and never the
// host's real command resolution: resolveCommand is a documented no-op on
// every non-win32 platform (docs/adapters.md "Windows command resolution"
// rule 1), so `cmd` stays the bare adapter name and `args` is never
// prefixed with a resolved `.js`/shim path, regardless of what happens to
// be sitting on the machine actually running this suite (a real `claude`/
// `codex`/`opencode` install, or none at all). Windows resolution itself is
// asserted separately, with `platform: 'win32'`/`platformOverride: 'win32'`
// and scratch PATH fixtures, in the "Windows command resolution" sections
// below and in test/resolve-command.test.mjs.

test('claude buildArgv: exact shape per docs/adapters.md', () => {
  const { cmd, args, env } = claude.buildArgv({
    prompt: 'do the thing',
    cwd: '/work',
    model: 'claude-opus-5',
    allowedTools: ['Read', 'Bash'],
    auth: 'subscription',
    platform: 'linux',
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
  const { args } = claude.buildArgv({ prompt: 'hi', cwd: '/work', platform: 'linux' });
  assert.deepEqual(args, ['-p', 'hi', '--output-format', 'stream-json', '--verbose']);
});

// ---------------------------------------------------------------------------
// claude: Windows command resolution (docs/adapters.md "Windows command
// resolution") - proves buildArgv actually wires resolveCommand's result
// into { cmd, args }, using a scratch PATH fixture rather than any real
// machine path.
// ---------------------------------------------------------------------------

test('claude buildArgv: win32 injected - a real claude.exe on PATH resolves into cmd, args unaffected', () => {
  const dir = makeTempDir();
  const exePath = join(dir, 'claude.exe');
  writeFileSync(exePath, '');

  const { cmd, args } = claude.buildArgv({
    prompt: 'do the thing',
    cwd: '/work',
    model: 'claude-opus-5',
    platform: 'win32',
    env: { PATH: dir },
  });
  assert.equal(cmd, exePath);
  assert.deepEqual(args, ['-p', 'do the thing', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5']);
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
  const { cmd, args } = codex.buildArgv({ prompt: 'review this', cwd: '/work', readOnly: true, outDir: '/out', platform: 'linux' });
  assert.equal(cmd, 'codex');
  assert.deepEqual(args, ['exec', '--json', '--sandbox', 'read-only', '--cd', '/work', '-o', join('/out', 'last-message.md'), 'review this']);
});

test('codex buildArgv: default sandbox workspace-write for builder roles', () => {
  const { args } = codex.buildArgv({ prompt: 'build this', cwd: '/work', outDir: '/out', platform: 'linux' });
  assert.ok(args.includes('workspace-write'));
});

test('codex buildArgv: resume passes -c sandbox_mode="read-only" and no --sandbox', () => {
  const { args } = codex.buildArgv({ prompt: 'continue', cwd: '/work', outDir: '/out', resumeThreadId: 'thread_123', platform: 'linux' });
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
    () => codex.buildArgv({ prompt: 'x', cwd: '/work', outDir: '/out', sandbox: 'danger-full-access', platform: 'linux' }),
    (e) => e instanceof Error && e.code === 1
  );
});

// ---------------------------------------------------------------------------
// codex: Windows command resolution (docs/adapters.md "Windows command
// resolution") - the reference machine's codex.cmd is the node-launcher
// shape, so both cmd and args change: the real .js path is prepended ahead
// of codex's own argv, exactly what applyResolvedCommand's prefixArgs are
// for.
// ---------------------------------------------------------------------------

test('codex buildArgv: win32 injected - node-launcher npm shim resolves to execPath + codex.js, prepended before codex\'s own args', () => {
  const dir = makeTempDir();
  writeFileSync(
    join(dir, 'codex.cmd'),
    '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  );
  const jsPath = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  mkdirSync(dirname(jsPath), { recursive: true });
  writeFileSync(jsPath, '');
  const fakeExecPath = 'C:\\fake\\nodejs\\node.exe';

  const { cmd, args } = codex.buildArgv({
    prompt: 'review this',
    cwd: '/work',
    readOnly: true,
    outDir: '/out',
    platform: 'win32',
    env: { PATH: dir },
    execPath: fakeExecPath,
  });
  assert.equal(cmd, fakeExecPath);
  assert.deepEqual(args, [
    jsPath,
    'exec', '--json', '--sandbox', 'read-only', '--cd', '/work', '-o', join('/out', 'last-message.md'), 'review this',
  ]);
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
    platformOverride: 'linux',
  });
  assert.equal(cmd, 'opencode');
  assert.deepEqual(args, ['run', '--agent', 'builder', '--model', 'opencode/deepseek-v4', '--format', 'json', 'build the thing']);
  assert.equal(env.XDG_DATA_HOME, join('/data', 'builder'));
  assert.equal(env.CORTEX_EVENTS_PATH, join('/out', 'events.jsonl'));
});

test('opencode buildArgv: omits --agent/--model when absent', () => {
  const { args } = opencode.buildArgv({ prompt: 'go', cwd: '/work', platformOverride: 'linux' });
  assert.deepEqual(args, ['run', '--format', 'json', 'go']);
});

// ---------------------------------------------------------------------------
// opencode: Windows command resolution (docs/adapters.md "Windows command
// resolution") - the reference machine's opencode.cmd is the direct-exe
// shape, so only cmd changes; args are untouched (no prefixArgs).
// ---------------------------------------------------------------------------

test('opencode buildArgv: win32 injected - direct-exe npm shim resolves to the real opencode.exe, args unaffected', () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, 'opencode.cmd'), '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n');
  const exePath = join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  mkdirSync(dirname(exePath), { recursive: true });
  writeFileSync(exePath, '');

  const { cmd, args } = opencode.buildArgv({
    prompt: 'build the thing',
    cwd: '/work',
    agent: 'builder',
    model: 'opencode/deepseek-v4',
    dataHome: '/data',
    outDir: '/out',
    platformOverride: 'win32',
    env: { PATH: dir },
  });
  assert.equal(cmd, exePath);
  assert.deepEqual(args, ['run', '--agent', 'builder', '--model', 'opencode/deepseek-v4', '--format', 'json', 'build the thing']);
});

// ---------------------------------------------------------------------------
// opencode: D1 - credential forwarding into the isolated data dir
// ---------------------------------------------------------------------------

test('opencode resolveRealOpencodeDataHome: XDG_DATA_HOME wins, on every platform (xdg-basedir is not platform-branched)', () => {
  assert.equal(
    opencode.resolveRealOpencodeDataHome({ env: { XDG_DATA_HOME: '/custom/data' }, homedir: '/home/op' }),
    join('/custom/data', 'opencode')
  );
});

test('opencode resolveRealOpencodeDataHome: falls back to <home>/.local/share/opencode when unset, Windows homedir included', () => {
  assert.equal(
    opencode.resolveRealOpencodeDataHome({ env: {}, homedir: '/home/op' }),
    join('/home/op', '.local', 'share', 'opencode')
  );
  // os.homedir() on win32 resolves to %USERPROFILE% - the same join logic
  // applies verbatim, per packages/core/src/global.ts (xdg-basedir is not
  // platform-branched).
  assert.equal(
    opencode.resolveRealOpencodeDataHome({ env: {}, homedir: 'C:\\Users\\op' }),
    join('C:\\Users\\op', '.local', 'share', 'opencode')
  );
});

test('opencode resolveRealAuthPath: <data home>/auth.json', () => {
  assert.equal(
    opencode.resolveRealAuthPath({ env: { XDG_DATA_HOME: '/custom/data' }, homedir: '/home/op' }),
    join('/custom/data', 'opencode', 'auth.json')
  );
});

test('opencode loadOperatorAuth: auth.json present - enumerates provider ids only, never values', () => {
  const authPath = '/fake/auth.json';
  const result = opencode.loadOperatorAuth({
    authPath,
    existsFn: (p) => p === authPath,
    readFile: () => JSON.stringify({ 'opencode-go': { type: 'oauth', access: 'super-secret-token' }, google: { type: 'api', key: 'also-secret' } }),
  });
  assert.equal(result.exists, true);
  assert.deepEqual(result.providers.sort(), ['google', 'opencode-go']);
  assert.equal(result.raw.includes('super-secret-token'), true, 'raw text is forwarded verbatim for OPENCODE_AUTH_CONTENT');
});

test('opencode loadOperatorAuth: auth.json absent', () => {
  const result = opencode.loadOperatorAuth({ authPath: '/fake/auth.json', existsFn: () => false });
  assert.deepEqual(result, { exists: false, providers: [], raw: null });
});

test('opencode buildArgv: dataHome set + real auth.json found -> OPENCODE_AUTH_CONTENT forwarded, credentials.forwarded event', () => {
  const authPath = join('/data', 'opencode', 'auth.json');
  const rawAuth = JSON.stringify({ 'opencode-go': { type: 'oauth' } });
  const { env, credentialsEvent } = opencode.buildArgv({
    prompt: 'x',
    cwd: '/work',
    agent: 'builder',
    model: 'opencode/deepseek-v4',
    dataHome: '/isolated',
    outDir: '/out',
    authEnv: { XDG_DATA_HOME: '/data' },
    authHomedir: '/home/op',
    authExistsSync: (p) => p === authPath,
    authReadFile: (p) => (p === authPath ? rawAuth : ''),
  });
  assert.equal(env.OPENCODE_AUTH_CONTENT, rawAuth);
  // The isolated XDG_DATA_HOME (sessions/db/snapshots/logs) is untouched by
  // credential forwarding - it still points at the isolated dir, not at
  // /data (the operator's real data home used only to find auth.json).
  assert.equal(env.XDG_DATA_HOME, join('/isolated', 'builder'));
  assert.equal(credentialsEvent.type, 'credentials.forwarded');
  assert.deepEqual(credentialsEvent.providers, ['opencode-go']);
  assert.equal(credentialsEvent.severity, 'info');
});

test('opencode buildArgv: dataHome set + real auth.json missing -> no OPENCODE_AUTH_CONTENT, credentials.missing event (warn)', () => {
  const { env, credentialsEvent } = opencode.buildArgv({
    prompt: 'x',
    cwd: '/work',
    agent: 'builder',
    model: 'opencode/x',
    dataHome: '/isolated',
    outDir: '/out',
    authEnv: {},
    authHomedir: '/home/op',
    authExistsSync: () => false,
  });
  assert.equal('OPENCODE_AUTH_CONTENT' in env, false);
  assert.equal(credentialsEvent.type, 'credentials.missing');
  assert.equal(credentialsEvent.severity, 'warn');
  assert.equal(credentialsEvent.path, join('/home/op', '.local', 'share', 'opencode', 'auth.json'));
});

test('opencode buildArgv: no dataHome (no isolation) -> no credential forwarding at all', () => {
  const { env, credentialsEvent } = opencode.buildArgv({ prompt: 'x', cwd: '/work', agent: 'builder', model: 'opencode/x' });
  assert.equal('OPENCODE_AUTH_CONTENT' in env, false);
  assert.equal(credentialsEvent, null);
});

test('opencode buildArgv: env-provided provider keys (NVIDIA/OPENAI/GOOGLE/GEMINI) still reach the child (docs/security.md rule 1 - only ANTHROPIC_/CLAUDE_/CORTEX_PROXY_ are ever stripped for opencode)', () => {
  const saved = {};
  const keys = ['NVIDIA_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'];
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.env.NVIDIA_API_KEY = 'nvapi-test';
    process.env.OPENAI_API_KEY = 'sk-test-openai-key-000000000000';
    process.env.GOOGLE_API_KEY = 'google-test';
    process.env.GEMINI_API_KEY = 'gemini-test';
    const { env } = opencode.buildArgv({ prompt: 'x', cwd: '/work', agent: 'builder', model: 'opencode/x' });
    assert.equal(env.NVIDIA_API_KEY, 'nvapi-test');
    assert.equal(env.OPENAI_API_KEY, 'sk-test-openai-key-000000000000');
    assert.equal(env.GOOGLE_API_KEY, 'google-test');
    assert.equal(env.GEMINI_API_KEY, 'gemini-test');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------------------------------------------------------------------------
// opencode: D2 - agent definition and permission binding
// ---------------------------------------------------------------------------

const BLIND_REVIEWER_TEMPLATE = join(HERE, '..', 'community', 'agents', 'blind-reviewer', 'config.json');

test('opencode buildArgv: no agentDef/template -> minimal {model} definition, still enough to fix "not found"', () => {
  const { env } = opencode.buildArgv({ prompt: 'x', cwd: '/work', agent: 'builder', model: 'opencode/deepseek-v4' });
  const generated = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(generated, { agent: { builder: { model: 'opencode/deepseek-v4' } } });
});

test('opencode buildArgv: agentDef.opencode is used verbatim (merged over the resolved model)', () => {
  const { env } = opencode.buildArgv({
    prompt: 'x',
    cwd: '/work',
    agent: 'architect',
    model: 'opencode/x',
    agentDef: { opencode: { temperature: 0.2, mode: 'primary' } },
  });
  const generated = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(generated.agent.architect, { model: 'opencode/x', temperature: 0.2, mode: 'primary' });
});

test('opencode buildArgv: --agent blind-reviewer via agentDef.template translates community config into OpenCode schema with byte-correct deny rules', () => {
  const { env } = opencode.buildArgv({
    prompt: 'review this',
    cwd: '/work',
    agent: 'blind-reviewer',
    model: 'google/gemini-x',
    agentDef: { template: BLIND_REVIEWER_TEMPLATE, read_only: true },
  });
  const generated = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  const def = generated.agent['blind-reviewer'];
  assert.equal(def.model, 'google/gemini-x');
  assert.equal(def.mode, 'primary');
  assert.equal(def.temperature, 0.0);
  assert.equal(typeof def.prompt, 'string');
  assert.ok(def.prompt.length > 0, 'prompt text should be the real contents of prompts/reviewer.md, not the {file:...} token');
  assert.equal(def.prompt.includes('{file:'), false);
  // The permission block itself, byte-correct against
  // community/agents/blind-reviewer/config.json (already written in
  // OpenCode's own schema shape - packages/core/src/v1/config/permission.ts).
  // `edit` is a per-path object (Rule = Action | Record<string, Action>,
  // same file): deny by default, except the exact path the reviewer is
  // required to write (docs/review-protocol.md "PR triage mode").
  assert.deepEqual(def.permission.edit, { '*': 'deny', '**/verdict.json': 'allow' });
  assert.equal(def.permission.read, 'allow');
  assert.deepEqual(def.permission.bash, {
    '*': 'deny',
    'git diff*': 'allow',
    'git show*': 'allow',
    'git log*': 'allow',
    'git status*': 'allow',
  });
  assert.equal(def.permission.webfetch, 'deny');
  assert.equal(def.permission.websearch, 'deny');
});

test('opencode buildArgv: read_only:true with no permission source refuses to launch (exit code 1) rather than run unrestricted', () => {
  assert.throws(
    () =>
      opencode.buildArgv({
        prompt: 'x',
        cwd: '/work',
        agent: 'reviewer',
        model: 'google/x',
        agentDef: { read_only: true },
      }),
    (e) => e instanceof Error && e.code === 1 && /read_only/.test(e.message)
  );
});

test('opencode buildArgv: read_only:true with agentDef.opencode that does deny edit is allowed to launch', () => {
  assert.doesNotThrow(() =>
    opencode.buildArgv({
      prompt: 'x',
      cwd: '/work',
      agent: 'reviewer',
      model: 'google/x',
      agentDef: { read_only: true, opencode: { permission: { edit: 'deny' } } },
    })
  );
});

test('opencode buildArgv: read_only:true with a per-path edit object (wildcard deny, one narrow allow) is allowed to launch - the verdict.json carve-out', () => {
  assert.doesNotThrow(() =>
    opencode.buildArgv({
      prompt: 'x',
      cwd: '/work',
      agent: 'reviewer',
      model: 'google/x',
      agentDef: {
        read_only: true,
        opencode: { permission: { edit: { '*': 'deny', '**/verdict.json': 'allow' } } },
      },
    })
  );
});

test('opencode buildArgv: read_only:true with a per-path edit object that is mostly-allow (wildcard allow) still refuses - a narrow deny entry does not make the default deny', () => {
  assert.throws(
    () =>
      opencode.buildArgv({
        prompt: 'x',
        cwd: '/work',
        agent: 'reviewer',
        model: 'google/x',
        agentDef: {
          read_only: true,
          opencode: { permission: { edit: { '*': 'allow', 'secret.txt': 'deny' } } },
        },
      }),
    (e) => e instanceof Error && e.code === 1 && /read_only/.test(e.message)
  );
});

test('opencode buildArgv: read_only:true with a per-path edit object with no wildcard entry cannot confirm deny-by-default and refuses', () => {
  assert.throws(
    () =>
      opencode.buildArgv({
        prompt: 'x',
        cwd: '/work',
        agent: 'reviewer',
        model: 'google/x',
        agentDef: {
          read_only: true,
          opencode: { permission: { edit: { '**/verdict.json': 'allow' } } },
        },
      }),
    (e) => e instanceof Error && e.code === 1 && /read_only/.test(e.message)
  );
});

test('opencode createStreamParser: "agent not found" fallback text becomes an agent.fallback event, severity warn', () => {
  const parser = opencode.createStreamParser();
  const events = parser.push('!  agent "builder" not found. Falling back to default agent');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.fallback');
  assert.equal(events[0].severity, 'warn');
  assert.equal(events[0].agent, 'builder');
  assert.equal(events[0].reason, 'not_found');
});

test('opencode createStreamParser: "subagent, not a primary agent" fallback text becomes an agent.fallback event too', () => {
  const parser = opencode.createStreamParser();
  const events = parser.push('!  agent "helper" is a subagent, not a primary agent. Falling back to default agent');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.fallback');
  assert.equal(events[0].severity, 'warn');
  assert.equal(events[0].agent, 'helper');
  assert.equal(events[0].reason, 'subagent');
});

// ---------------------------------------------------------------------------
// opencode: E2-3 - the real `opencode run --format json` stream
// ---------------------------------------------------------------------------
//
// test/fixtures/opencode-run.real.jsonl is a real `opencode run --format
// json --agent builder --model nvidia/moonshotai/kimi-k3` capture (OpenCode
// 1.18.27, Windows, exit 0, 46s) with every absolute path replaced by
// `<worktree>` - see docs/adapters.md "opencode: parsing the real run
// --format json stream" for the citation trail. Session id, timestamps, and
// token numbers are byte-identical to the real run.

test('opencode parseStream: real run --format json fixture - exactly one session.start, deduped', () => {
  const events = opencode.parseStream(readFixtureLines('opencode-run.real.jsonl'));
  const starts = events.filter((e) => e.type === 'session.start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].session_id, 'ses_f80e1b494ffeeIFRT1L2arjhAx');
});

test('opencode parseStream: real fixture - two step_finish events become two message (token) events with the exact reported numbers', () => {
  const events = opencode.parseStream(readFixtureLines('opencode-run.real.jsonl'));
  const messages = events.filter((e) => e.type === 'message');
  assert.equal(messages.length, 2);

  assert.equal(messages[0].tokens_in, 29241);
  assert.equal(messages[0].tokens_out, 81);
  assert.equal(messages[0].cost_usd, 0);
  assert.equal(messages[0].usage_source, 'reported');

  assert.equal(messages[1].tokens_in, 29405);
  assert.equal(messages[1].tokens_out, 64);
  assert.equal(messages[1].cost_usd, 0);
  assert.equal(messages[1].usage_source, 'reported');
});

test('opencode parseStream: real fixture - the completed tool_use becomes one tool.call and one tool.result for "read"', () => {
  const events = opencode.parseStream(readFixtureLines('opencode-run.real.jsonl'));
  const calls = events.filter((e) => e.type === 'tool.call');
  const results = events.filter((e) => e.type === 'tool.result');
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(calls[0].tool, 'read');
  assert.equal(calls[0].call_id, 'read:0');
  assert.equal(results[0].tool, 'read');
  assert.equal(results[0].call_id, 'read:0');
  assert.equal(results[0].ok, true);
  assert.equal(results[0].ms, 4);
  // No raw tool input/output body ever leaves the parser (docs/adapters.md
  // "Never log tool arguments in full") - only a capped summary on the call.
  assert.ok(calls[0].args_summary.length <= 200);
  assert.equal(JSON.stringify(events).includes('<entries>'), false, 'the tool_use output body must never leak into events.jsonl');
});

test('opencode parseStream: real fixture - synthesized session.end totals and unparsed_lines', () => {
  const events = opencode.parseStream(readFixtureLines('opencode-run.real.jsonl'));
  const ends = events.filter((e) => e.type === 'session.end');
  assert.equal(ends.length, 1);
  const end = ends[0];
  assert.equal(end.session_id, 'ses_f80e1b494ffeeIFRT1L2arjhAx');
  assert.equal(end.tokens_in, 58646);
  assert.equal(end.tokens_out, 145);
  assert.equal(end.cost_usd, 0);
  assert.equal(end.requests, 2);
  assert.equal(end.unparsed_lines, 0);
  // This stream never reports its own exit code or elapsed time - run()
  // patches both from the real spawned process; a bare parseStream() over
  // the raw fixture (no process to patch from) must not fabricate either.
  assert.equal(end.exit_code, null);
  assert.equal(end.elapsed_ms, null);
});

test('opencode createStreamParser: a 410 Gone error line becomes a halt error event with status_code and a capped message, exit code left untouched', () => {
  const parser = opencode.createStreamParser();
  const line = JSON.stringify({
    type: 'error',
    timestamp: 1788839200000,
    sessionID: 'ses_eol_model_test',
    error: { name: 'APIError', data: { message: 'The model `nvidia/some-eol-model` has been retired and is no longer available.', statusCode: 410, isRetryable: false } },
  });
  const events = parser.push(line);
  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.severity, 'halt');
  assert.equal(errorEvent.status_code, 410);
  assert.equal(errorEvent.retryable, false);
  assert.equal(errorEvent.name, 'APIError');
  assert.ok(errorEvent.message.includes('retired'));
  assert.equal('exit_code' in errorEvent, false, 'an error event never sets an exit code itself - the process exit code stays authoritative');

  const end = parser.flush().find((e) => e.type === 'session.end');
  assert.equal(end.exit_code, null);
});

test('opencode createStreamParser: a 401 Unauthorized error line becomes a halt error event too', () => {
  const parser = opencode.createStreamParser();
  const line = JSON.stringify({
    type: 'error',
    timestamp: 1788839200000,
    sessionID: 'ses_unauthorized_test',
    error: { name: 'APIError', data: { message: 'Unauthorized: invalid or missing API key for provider nvidia.', statusCode: 401, isRetryable: false } },
  });
  const events = parser.push(line);
  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.severity, 'halt');
  assert.equal(errorEvent.status_code, 401);
  assert.equal(errorEvent.retryable, false);
  assert.ok(errorEvent.message.includes('Unauthorized'));
});

// Phase 1a real-batch fix F1: the real evidence this fix is built from - 12
// of 16 runs in the live batch failed on exactly this shape, a 429 "Too Many
// Requests" from nvidia's API with isRetryable: true.
test('opencode createStreamParser: a 429 Too Many Requests error line is retryable', () => {
  const parser = opencode.createStreamParser();
  const line = JSON.stringify({
    type: 'error',
    timestamp: 1788839200000,
    sessionID: 'ses_429_test',
    error: {
      name: 'APIError',
      data: {
        message: 'Too Many Requests: {"status":429,"title":"Too Many Requests"}',
        statusCode: 429,
        isRetryable: true,
        metadata: { url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
      },
    },
  });
  const events = parser.push(line);
  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.status_code, 429);
  assert.equal(errorEvent.retryable, true);
});

test('claude createStreamParser: a top-level error line carrying a 429 status becomes a retryable halt error event', () => {
  const parser = claude.createStreamParser();
  const line = JSON.stringify({ type: 'error', error: { status_code: 429, message: 'rate limited' } });
  const events = parser.push(line);
  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.severity, 'halt');
  assert.equal(errorEvent.status_code, 429);
  assert.equal(errorEvent.retryable, true);
  assert.ok(errorEvent.message.includes('rate limited'));
});

test('claude createStreamParser: an error line with no status, or a non-transient status, is not retryable', () => {
  const parser = claude.createStreamParser();
  assert.equal(parser.push(JSON.stringify({ type: 'error', error: { message: 'something broke' } }))[0].retryable, false);
  assert.equal(parser.push(JSON.stringify({ type: 'error', error: { status_code: 400, message: 'bad request' } }))[0].retryable, false);
});

test('codex createStreamParser: a top-level error line carrying a 503 status becomes a retryable halt error event', () => {
  const parser = codex.createStreamParser();
  const line = JSON.stringify({ type: 'error', error: { statusCode: 503, message: 'service unavailable' } });
  const events = parser.push(line);
  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent);
  assert.equal(errorEvent.severity, 'halt');
  assert.equal(errorEvent.status_code, 503);
  assert.equal(errorEvent.retryable, true);
});

test('codex createStreamParser: an error line with a non-transient status is not retryable', () => {
  const parser = codex.createStreamParser();
  const events = parser.push(JSON.stringify({ type: 'error', error: { statusCode: 404, message: 'not found' } }));
  assert.equal(events[0].retryable, false);
});

test('opencode createStreamParser: unknown raw JSON type is ignored but counted in session.end.unparsed_lines', () => {
  const parser = opencode.createStreamParser();
  parser.push(JSON.stringify({ type: 'step_start', sessionID: 'ses_x' }));
  const events = parser.push(JSON.stringify({ type: 'some_future_part_type', sessionID: 'ses_x', part: {} }));
  assert.deepEqual(events, []);
  const end = parser.flush().find((e) => e.type === 'session.end');
  assert.equal(end.unparsed_lines, 1);
});

test('opencode createStreamParser: the "agent not found" fallback text still works alongside the real JSON stream (D2 unaffected by E2-3)', () => {
  const parser = opencode.createStreamParser();
  parser.push(JSON.stringify({ type: 'step_start', sessionID: 'ses_x' }));
  const events = parser.push('!  agent "builder" not found. Falling back to default agent');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'agent.fallback');
});

// ---------------------------------------------------------------------------
// opencode: tool args_summary must never contain the operator's absolute
// worktree path - a real run captured `read`'s own `state.input.filePath`
// verbatim (a `D:\...` path on Windows). createStreamParser({ cwd }) now
// relativizes it (relativizeToCwd, src/adapters/credential-boundary.mjs).
// ---------------------------------------------------------------------------

const FAKE_ABS_CWD = 'D:\\CoWork\\Community\\_scratch\\oc-smoke-fake\\worktree';
// A personal path survives however many rounds of JSON escaping the value
// passes through (args_summary is itself a JSON.stringify'd string embedded
// as a field of an event object that is later JSON.stringify'd again to
// write events.jsonl) - a plain-letters substring like this one is the
// leak-detection check that stays meaningful regardless of how many
// backslashes get doubled along the way; `JSON.stringify(FAKE_ABS_CWD)`
// (minus its surrounding quotes) is used wherever a test needs the exact
// one-level-escaped form instead.
const CWD_TELLTALE = 'CoWork';
const ESCAPED_CWD = JSON.stringify(FAKE_ABS_CWD).slice(1, -1);

function realToolUseLine(filePath) {
  return JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_cwd_test',
    part: {
      type: 'tool',
      tool: 'read',
      callID: 'read:0',
      state: { status: 'completed', input: { filePath }, output: `<path>${filePath}</path>`, time: { start: 1, end: 5 } },
    },
  });
}

test('opencode createStreamParser: with no cwd given, args_summary still contains the absolute path (documents the pre-fix shape)', () => {
  const parser = opencode.createStreamParser();
  const events = parser.push(realToolUseLine(FAKE_ABS_CWD));
  const call = events.find((e) => e.type === 'tool.call');
  assert.ok(call.args_summary.includes(CWD_TELLTALE));
  assert.ok(call.args_summary.includes(ESCAPED_CWD));
});

test('opencode createStreamParser({ cwd }): args_summary is relativized when the tool input path equals cwd exactly', () => {
  const parser = opencode.createStreamParser({ cwd: FAKE_ABS_CWD });
  const events = parser.push(realToolUseLine(FAKE_ABS_CWD));
  const call = events.find((e) => e.type === 'tool.call');
  assert.equal(call.args_summary.includes(CWD_TELLTALE), false, 'the absolute cwd must never reach args_summary');
  assert.ok(call.args_summary.includes('"filePath":"."'), `expected a "." relative path, got: ${call.args_summary}`);
});

test('opencode createStreamParser({ cwd }): args_summary is relativized when the tool input path is a subpath of cwd', () => {
  const parser = opencode.createStreamParser({ cwd: FAKE_ABS_CWD });
  const events = parser.push(realToolUseLine(`${FAKE_ABS_CWD}\\src\\x.mjs`));
  const call = events.find((e) => e.type === 'tool.call');
  assert.equal(call.args_summary.includes(CWD_TELLTALE), false);
  assert.equal(call.args_summary, '{"filePath":".\\\\src\\\\x.mjs"}');
});

test('opencode parseStream(lines, { cwd }): the real fixture with a fake absolute cwd substituted for <worktree> is relativized end to end', () => {
  // Backslashes must be doubled to stay valid inside the JSON text itself -
  // the `cwd` passed to parseStream is the real (single-backslash) string.
  const jsonEscapedCwd = FAKE_ABS_CWD.replace(/\\/g, '\\\\');
  const raw = readFixtureLines('opencode-run.real.jsonl').map((l) => l.replaceAll('<worktree>', jsonEscapedCwd));
  const events = opencode.parseStream(raw, { cwd: FAKE_ABS_CWD });
  const call = events.find((e) => e.type === 'tool.call');
  assert.ok(call, 'the read tool.call should still be produced');
  assert.equal(JSON.stringify(events).includes(CWD_TELLTALE), false, 'no event may contain the absolute cwd once cwd is known');
});

test('opencode parseStream: omitting { cwd } is a no-op - unaffected callers (every pre-existing test) behave exactly as before', () => {
  const events = opencode.parseStream(readFixtureLines('opencode-run.real.jsonl'));
  const call = events.find((e) => e.type === 'tool.call');
  assert.ok(call.args_summary.length <= 200);
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
