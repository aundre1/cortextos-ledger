// config.tools validation (docs/adapters.md "Windows command resolution",
// src/config.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { makeTempDir } from './helpers.mjs';

function writeConfig(dir, obj) {
  const p = join(dir, 'cortex-ledger.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('config.tools: absent by default, no error', () => {
  const cwd = makeTempDir();
  const config = loadConfig({ cwd });
  assert.equal(config.tools, undefined);
});

test('config.tools: a valid argv-array override round-trips unchanged', () => {
  const cwd = makeTempDir();
  const configPath = writeConfig(cwd, { tools: { gh: ['C:/tools/gh.exe'], opencode: ['/x/opencode', '--flag'] } });
  const config = loadConfig({ configPath, cwd });
  assert.deepEqual(config.tools, { gh: ['C:/tools/gh.exe'], opencode: ['/x/opencode', '--flag'] });
});

test('config.tools: a non-array value is rejected', () => {
  const cwd = makeTempDir();
  const configPath = writeConfig(cwd, { tools: { gh: 'C:/tools/gh.exe' } });
  assert.throws(() => loadConfig({ configPath, cwd }), /tools\.gh must be a non-empty array/);
});

test('config.tools: an empty array is rejected', () => {
  const cwd = makeTempDir();
  const configPath = writeConfig(cwd, { tools: { gh: [] } });
  assert.throws(() => loadConfig({ configPath, cwd }), /tools\.gh must be a non-empty array/);
});

test('config.tools: an array containing a non-string is rejected', () => {
  const cwd = makeTempDir();
  const configPath = writeConfig(cwd, { tools: { gh: ['gh', 42] } });
  assert.throws(() => loadConfig({ configPath, cwd }), /tools\.gh must be a non-empty array/);
});

test('config.tools: an array containing an empty string is rejected', () => {
  const cwd = makeTempDir();
  const configPath = writeConfig(cwd, { tools: { gh: [''] } });
  assert.throws(() => loadConfig({ configPath, cwd }), /tools\.gh must be a non-empty array/);
});

test('config.tools: a non-object value for tools itself is rejected', () => {
  const cwd = makeTempDir();
  const configPath = writeConfig(cwd, { tools: ['not', 'an', 'object'] });
  assert.throws(() => loadConfig({ configPath, cwd }), /tools must be an object/);
});
