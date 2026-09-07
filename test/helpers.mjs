// Shared test helpers: temp dirs, temp db paths, a temp git repo with one
// commit, and a CLI spawn wrapper. No /tmp literals (os.tmpdir() instead),
// no shell pipes, no chmod, so this runs the same on Windows and POSIX.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'bin', 'cortexctl.mjs');

/** A fresh empty temp directory. */
export function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'cortex-test-'));
}

/** Path to a not-yet-created db file inside a fresh temp directory. */
export function makeTempDb() {
  return join(makeTempDir(), 'ledger.db');
}

/** A fresh git repo with exactly one commit. Returns { dir, baseCommit }. */
export function makeTempGitRepo() {
  const dir = makeTempDir();
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });

  git(['init', '--quiet']);
  git(['config', 'user.email', 'cortex-test@example.invalid']);
  git(['config', 'user.name', 'Cortex Test']);

  writeFileSync(join(dir, 'README.md'), 'cortextos-ledger test fixture repo\n');
  git(['add', 'README.md']);
  git(['commit', '--quiet', '-m', 'initial commit']);

  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  return { dir, baseCommit };
}

/**
 * Spawn `node bin/cortexctl.mjs <args>` and collect the result.
 * Returns { code, stdout, stderr }.
 */
export function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: cwd ?? process.cwd(),
    env: env ?? process.env,
    encoding: 'utf8',
    shell: false,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
