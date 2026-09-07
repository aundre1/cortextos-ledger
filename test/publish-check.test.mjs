// Tests for scripts/publish-check.mjs (docs/security.md, docs/measurement.md):
// a clean staged file exits 0, a staged secret exits 2 without leaking the
// secret value into stdout/stderr, and a staged .cortex/ path exits 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempGitRepo } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, '..', 'scripts', 'publish-check.mjs');

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

function runPublishCheck(dir) {
  return spawnSync(process.execPath, [SCRIPT_PATH], { cwd: dir, encoding: 'utf8' });
}

test('a clean staged file passes with exit 0', () => {
  const { dir } = makeTempGitRepo();
  writeFileSync(join(dir, 'notes.txt'), 'nothing sensitive here\n');
  git(dir, ['add', 'notes.txt']);

  const result = runPublishCheck(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^OK /);
});

test('a staged file containing a ghp_ token exits 2 and never prints the token', () => {
  const { dir } = makeTempGitRepo();
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  assert.equal(token.length, 'ghp_'.length + 36);
  writeFileSync(join(dir, 'leak.txt'), `token=${token}\n`);
  git(dir, ['add', 'leak.txt']);

  const result = runPublishCheck(dir);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const combined = result.stdout + result.stderr;
  assert.ok(!combined.includes(token), 'the secret value must never appear in output');
  assert.match(combined, /leak\.txt:1/);
});

test('a staged path under .cortex/ exits 2', () => {
  const { dir } = makeTempGitRepo();
  mkdirSync(join(dir, '.cortex'), { recursive: true });
  writeFileSync(join(dir, '.cortex', 'x'), 'db bytes or whatever\n');
  git(dir, ['add', '.cortex/x']);

  const result = runPublishCheck(dir);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /\.cortex\/x/);
});
