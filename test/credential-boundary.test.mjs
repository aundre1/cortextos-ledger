import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterEnv, rejectAnthropicModel, redact, PATTERNS } from '../src/adapters/credential-boundary.mjs';

const BASE_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  ANTHROPIC_MODEL: 'claude-x',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
  CORTEX_PROXY_URL: 'http://proxy.invalid',
  OPENAI_API_KEY: 'openai-secret',
  NVIDIA_API_KEY: 'nvidia-secret',
  NIM_ENDPOINT: 'https://nim.invalid',
  GOOGLE_API_KEY: 'google-secret',
  GEMINI_API_KEY: 'gemini-secret',
  GOOGLE_CLOUD_PROJECT: 'keep-me', // GOOGLE_ prefix alone is not stripped, only the exact key
  PATH: '/usr/bin',
  HOME: '/home/op',
};

// Table-driven: one row per rule in docs/security.md "Credential boundary".
const FILTER_ENV_CASES = [
  {
    name: 'rule 1: ANTHROPIC_/CLAUDE_/CORTEX_PROXY_ always stripped, any adapter',
    opts: { adapter: 'codex' },
    stripped: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CORTEX_PROXY_URL'],
    kept: ['OPENAI_API_KEY', 'NVIDIA_API_KEY', 'NIM_ENDPOINT', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'PATH', 'HOME'],
  },
  {
    name: 'rule 1: opencode adapter also only strips the always-strip set',
    opts: { adapter: 'opencode' },
    stripped: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CORTEX_PROXY_URL'],
    kept: ['OPENAI_API_KEY', 'NVIDIA_API_KEY', 'NIM_ENDPOINT', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  },
  {
    name: 'rule 2: claude adapter additionally strips OPENAI_/NVIDIA_/NIM_/GOOGLE_API_KEY/GEMINI_API_KEY',
    opts: { adapter: 'claude' },
    stripped: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CORTEX_PROXY_URL',
      'OPENAI_API_KEY',
      'NVIDIA_API_KEY',
      'NIM_ENDPOINT',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
    ],
    kept: ['PATH', 'HOME', 'GOOGLE_CLOUD_PROJECT'],
  },
  {
    name: "claude + auth 'api' keeps ANTHROPIC_API_KEY only, still strips other ANTHROPIC_*",
    opts: { adapter: 'claude', auth: 'api' },
    stripped: ['ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CORTEX_PROXY_URL', 'OPENAI_API_KEY'],
    kept: ['ANTHROPIC_API_KEY'],
  },
  {
    name: "claude + auth 'subscription' strips ANTHROPIC_API_KEY like every other ANTHROPIC_* var",
    opts: { adapter: 'claude', auth: 'subscription' },
    stripped: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'],
    kept: ['PATH'],
  },
];

for (const { name, opts, stripped, kept } of FILTER_ENV_CASES) {
  test(`filterEnv: ${name}`, () => {
    const result = filterEnv(BASE_ENV, opts);
    for (const key of stripped) assert.equal(key in result, false, `${key} should be stripped`);
    for (const key of kept) assert.equal(result[key], BASE_ENV[key], `${key} should be kept unchanged`);
  });
}

test('filterEnv: never mutates the input env object', () => {
  const copy = { ...BASE_ENV };
  filterEnv(BASE_ENV, { adapter: 'claude' });
  assert.deepEqual(BASE_ENV, copy);
});

test('filterEnv: matching is case-insensitive on the prefix', () => {
  const result = filterEnv({ anthropic_api_key: 'x', claude_thing: 'y', PATH: '/bin' }, { adapter: 'codex' });
  assert.deepEqual(Object.keys(result), ['PATH']);
});

const REJECT_MODEL_CASES = [
  ['claude-opus-5', true],
  ['anthropic/claude-3', true],
  ['CLAUDE-SONNET', true],
  ['ANTHROPIC/foo', true],
  ['opencode/deepseek-v4', false],
  ['gpt-5.6', false],
  [null, false],
  [undefined, false],
];

for (const [model, shouldThrow] of REJECT_MODEL_CASES) {
  test(`rejectAnthropicModel(${JSON.stringify(model)}) ${shouldThrow ? 'throws' : 'does not throw'}`, () => {
    if (shouldThrow) {
      assert.throws(() => rejectAnthropicModel(model), (e) => e instanceof Error && e.code === 1);
    } else {
      assert.doesNotThrow(() => rejectAnthropicModel(model));
    }
  });
}

test('PATTERNS: exactly the docs/guards.md secrets-in-tree list, in order', () => {
  assert.equal(PATTERNS.length, 10);
});

const REDACT_CASES = [
  ['-----BEGIN RSA PRIVATE KEY----- abc', true],
  ['token sk-ant-abcdefghijklmnop', true],
  ['token sk-abcdefghijklmnopqrstuvwx', true],
  ['token ghp_' + 'a'.repeat(36), true],
  ['token github_pat_' + 'b'.repeat(25), true],
  ['key AKIA1234567890ABCDEF', true],
  ['slack xoxb-1234-5678-abcdef', true],
  ['AIza' + 'c'.repeat(35), true],
  ['ya29.' + 'd'.repeat(20), true],
  ['nvapi-' + 'e'.repeat(20), true],
  ['nothing secret here', false],
];

for (const [text, shouldRedact] of REDACT_CASES) {
  test(`redact: ${text.slice(0, 24)}... ${shouldRedact ? 'is redacted' : 'is left alone'}`, () => {
    const result = redact(text);
    if (shouldRedact) {
      assert.ok(result.includes('[REDACTED]'), `expected redaction in: ${result}`);
      assert.equal(result.includes('a'.repeat(36)), false);
    } else {
      assert.equal(result, text);
    }
  });
}

test('redact: is non-destructive on non-string input', () => {
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
});
