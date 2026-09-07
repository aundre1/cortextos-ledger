// Task E1-1: PR capture on task:new (docs/review-protocol.md "PR triage
// mode"). `task:new --kind pr_review --repo owner/name --pr N` shells out to
// a real `gh` executable resolved through PATH - this test builds one on
// disk (a stub, not the real GitHub CLI) and drives the actual task:new code
// path end to end. No monkey-patching spawnSync, no mocked module: the CLI
// is spawned as a real child process (test/helpers.mjs's runCli) with the
// stub's directory placed first on that child's PATH, exactly as an
// operator's real `gh` would be found.
//
// Windows note: a portable stub here needs a `.exe`/`.cmd`/`.bat` (Node
// cannot exec a bare, no-extension file with a shebang on Windows the way
// POSIX does), which this test does not attempt - it skips cleanly on
// win32. The Linux/POSIX path below genuinely writes an executable file
// named `gh`, chmod 0o755, and executes it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, makeTempDir, makeTempDb } from './helpers.mjs';
import { openDb } from '../src/db.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STUB_SOURCE = join(HERE, 'fixtures', 'gh-stub.mjs');

const GHP_TOKEN = `ghp_${'A'.repeat(36)}`; // matches src/guards/secrets-scan.mjs's github_pat_classic exactly
const IS_WIN32 = process.platform === 'win32';

/**
 * Write the gh stub to a fresh temp directory as a file literally named
 * `gh` (no extension), chmod 0o755, and return that directory's path so it
 * can be prepended to a child process's PATH.
 */
function makeStubBinDir() {
  const dir = makeTempDir();
  const ghPath = join(dir, 'gh');
  copyFileSync(STUB_SOURCE, ghPath);
  chmodSync(ghPath, 0o755);
  return dir;
}

/**
 * A fresh { workDir, dbPath, cli } trio. cli(args, extraEnv) runs cortexctl
 * with the gh stub's directory first on PATH and no --config, so
 * config.runs resolves to <workDir>/.cortex/runs (src/config.mjs's default,
 * relative to cwd when no config file is found) - the same runs-root
 * resolution every other command in the kit already uses.
 */
function makeHarness() {
  const workDir = makeTempDir();
  const dbPath = makeTempDb();
  const binDir = makeStubBinDir();
  const cli = (args, extraEnv = {}) =>
    runCli(['--db', dbPath, ...args], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        ...extraEnv,
      },
    });
  return { workDir, dbPath, cli };
}

function briefMessagesFor(dbPath, taskId) {
  const db = openDb(dbPath);
  try {
    return db
      .prepare("SELECT * FROM agent_messages WHERE task_id = ? AND kind = 'brief' ORDER BY created_at DESC")
      .all(taskId);
  } finally {
    db.close();
  }
}

function artifactsFor(dbPath, taskId) {
  const db = openDb(dbPath);
  try {
    return db.prepare('SELECT * FROM artifacts WHERE task_id = ?').all(taskId);
  } finally {
    db.close();
  }
}

function taskCount(dbPath) {
  const db = openDb(dbPath);
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  } finally {
    db.close();
  }
}

const newTaskArgs = (extra = []) => [
  'task:new',
  '--repo', 'o/n', '--title', 'PR review task', '--class', 'pr-triage', '--arm', 'control',
  '--kind', 'pr_review', '--pr', '42',
  ...extra,
];

if (IS_WIN32) {
  test('pr-capture: skipped on win32 (no portable no-extension gh stub)', { skip: true }, () => {});
} else {
  test('task:new --kind pr_review --repo --pr: happy path captures pr_number/pr_repo/base_sha/head_sha, pr.diff, brief, artifact', () => {
    const { workDir, dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);

    const diffText = 'diff --git a/feature.mjs b/feature.mjs\n+console.log("hi");\n';
    const result = cli(newTaskArgs(), {
      GH_STUB_TITLE: 'Fix the widget',
      GH_STUB_BODY: 'This fixes the widget that was broken.',
      GH_STUB_BASE_SHA: 'base111111111111111111111111111111111111',
      GH_STUB_HEAD_SHA: 'head222222222222222222222222222222222222',
      GH_STUB_BASE_REF: 'main',
      GH_STUB_HEAD_REF: 'fix-widget',
      GH_STUB_DIFF: diffText,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const taskId = result.stdout.trim();
    assert.match(taskId, /^t_/);

    const shown = cli(['task:show', taskId, '--json']);
    assert.equal(shown.code, 0, shown.stderr);
    const view = JSON.parse(shown.stdout);
    assert.equal(view.task.pr_number, 42);
    assert.equal(view.task.pr_repo, 'o/n');
    assert.equal(view.task.base_sha, 'base111111111111111111111111111111111111');
    assert.equal(view.task.head_sha, 'head222222222222222222222222222222222222');
    // base_commit/branch default from the PR when not given explicitly.
    assert.equal(view.task.base_commit, 'base111111111111111111111111111111111111');
    assert.equal(view.task.branch, 'fix-widget');

    // pr.diff written under the same runs-root every other command uses,
    // with exactly the stub's bytes (nothing to redact here).
    const diffPath = join(workDir, '.cortex', 'runs', taskId, 'pr.diff');
    assert.ok(existsSync(diffPath), `expected ${diffPath} to exist`);
    assert.equal(readFileSync(diffPath, 'utf8'), diffText);

    // Brief message via the existing agent_messages/kind=brief mechanism.
    const briefs = briefMessagesFor(dbPath, taskId);
    assert.equal(briefs.length, 1);
    assert.match(briefs[0].body, /Fix the widget/);
    assert.match(briefs[0].body, /This fixes the widget that was broken\./);
    assert.equal(briefs[0].sender, 'ledger');

    // Diff artifact row (docs/ledger.md: artifacts kind gains pr_review).
    const artifacts = artifactsFor(dbPath, taskId);
    const prArtifact = artifacts.find((a) => a.kind === 'pr_review');
    assert.ok(prArtifact, 'expected a pr_review artifact row');
    assert.equal(prArtifact.path, diffPath);
    assert.equal(prArtifact.bytes, Buffer.byteLength(diffText, 'utf8'));
  });

  test('task:new --kind pr_review: gh exits non-zero, task is not created, exit code matches the reason', () => {
    const { dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);

    const before = taskCount(dbPath);
    const result = cli(newTaskArgs(), {
      GH_STUB_VIEW_EXIT: '1',
      GH_STUB_VIEW_STDERR: 'gh: pull request not found (stub)',
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cortexctl: gh_failed:/);
    assert.match(result.stderr, /pull request not found/);
    assert.equal(taskCount(dbPath), before, 'no task row should have been inserted');
  });

  test('task:new --kind pr_review: gh binary missing fails cleanly instead of hanging or crashing', () => {
    // An empty stub dir on PATH (still prepended ahead of the real PATH, but
    // this test's PATH omits it) - simulate "gh not installed" by pointing
    // PATH at a directory with nothing in it, ahead of the real PATH so any
    // system-installed `gh` is still masked for this one call.
    const { workDir, dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);
    const before = taskCount(dbPath);

    const emptyDir = join(workDir, 'empty-path');
    const result = runCli(['--db', dbPath, ...newTaskArgs()], {
      cwd: workDir,
      env: { ...process.env, PATH: emptyDir },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cortexctl: gh_missing:/);
    assert.equal(taskCount(dbPath), before, 'no task row should have been inserted');
  });

  test('task:new --kind pr_review: a secret-looking token in the PR body is redacted at rest', () => {
    const { dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);

    const result = cli(newTaskArgs(), {
      GH_STUB_TITLE: 'Rotate the token',
      GH_STUB_BODY: `Old token was ${GHP_TOKEN}, now rotated.`,
    });
    assert.equal(result.code, 0, result.stderr);
    const taskId = result.stdout.trim();

    const briefs = briefMessagesFor(dbPath, taskId);
    assert.equal(briefs.length, 1);
    assert.ok(!briefs[0].body.includes(GHP_TOKEN), 'the raw token must never be stored');
    assert.match(briefs[0].body, /\[REDACTED\]/);
  });

  test('task:new --kind pr_review: a diff over the 2,000,000 byte guard is still written in full, with a note and a warning', () => {
    const { workDir, dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);

    const bigDiffPath = join(workDir, 'big.diff');
    const line = 'diff line filler to push this file past the size guard\n';
    const linesNeeded = Math.ceil(2_100_000 / Buffer.byteLength(line, 'utf8'));
    writeFileSync(bigDiffPath, line.repeat(linesNeeded));
    const expectedBytes = readFileSync(bigDiffPath).length;
    assert.ok(expectedBytes > 2_000_000, 'fixture diff must exceed the size guard to exercise it');

    const result = cli(newTaskArgs(), { GH_STUB_DIFF_FILE: bigDiffPath });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /warning:.*over the 2000000 byte guard/);
    const taskId = result.stdout.trim();

    const diffPath = join(workDir, '.cortex', 'runs', taskId, 'pr.diff');
    const writtenBytes = readFileSync(diffPath).length;
    assert.equal(writtenBytes, expectedBytes, 'the diff must be written in full, never truncated');

    const shown = cli(['task:show', taskId, '--json']);
    const view = JSON.parse(shown.stdout);
    assert.match(view.task.notes ?? '', /pr_diff_oversized:\d+/);
  });
}
