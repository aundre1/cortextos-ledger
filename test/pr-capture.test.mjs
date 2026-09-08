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
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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

/**
 * Every entry directly under `<workDir>/.cortex/runs/` other than `.tmp`
 * itself (review round 2, F4 tests): a fresh task directory shows up here,
 * a cleaned-up failed capture must not. Returns [] if the runs root does
 * not exist at all yet.
 */
function taskDirsUnderRuns(workDir) {
  const runsRoot = join(workDir, '.cortex', 'runs');
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot).filter((name) => name !== '.tmp');
}

/** Entries left behind in `<workDir>/.cortex/runs/.tmp/`, or [] if that directory does not exist (never created, or nothing ever landed in it). */
function leftoverTmpFiles(workDir) {
  const tmpDir = join(workDir, '.cortex', 'runs', '.tmp');
  if (!existsSync(tmpDir)) return [];
  return readdirSync(tmpDir);
}

// A syntactically valid AWS access key id (matches src/guards/secrets-scan.mjs's
// aws_access_key pattern AKIA[0-9A-Z]{16} exactly) planted inside a large
// generated diff fixture, never committed as a file (review round 2, F6).
const AKIA_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`;

/**
 * Writes a synthetic diff of at least `targetBytes` to `path` via a chunked
 * synchronous write loop (never building the whole thing as one in-memory
 * string) with `secretLine` planted roughly halfway through - large enough
 * to exercise the 2,000,000 byte size guard and, for the 70 MB variant, the
 * spawnSync ENOBUFS repro this task fixes (F6), without ever committing a
 * multi-megabyte fixture file to the repo.
 */
function writeLargeDiffFixture(path, targetBytes, secretLine) {
  const fd = openSync(path, 'w');
  try {
    const line = 'diff line filler padding padding padding padding padding\n';
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const half = Math.floor(targetBytes / 2);
    let written = 0;
    while (written < half) {
      writeSync(fd, line);
      written += lineBytes;
    }
    if (secretLine) {
      const secretText = `${secretLine}\n`;
      writeSync(fd, secretText);
      written += Buffer.byteLength(secretText, 'utf8');
    }
    while (written < targetBytes) {
      writeSync(fd, line);
      written += lineBytes;
    }
  } finally {
    closeSync(fd);
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
    assert.match(prArtifact.sha256, /^[0-9a-f]{64}$/, 'sha256 should be computed even though it was precomputed off the temp file, not the final path');

    // Review round 2, F4: on the happy path the temp file was renamed into
    // place, not left behind alongside it.
    assert.deepEqual(leftoverTmpFiles(workDir), []);
  });

  test('task:new --kind pr_review: gh exits non-zero, task is not created, exit code matches the reason', () => {
    const { workDir, dbPath, cli } = makeHarness();
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
    assert.deepEqual(taskDirsUnderRuns(workDir), [], 'no task directory should exist');
    assert.deepEqual(leftoverTmpFiles(workDir), [], 'no temp file should be left behind');
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
    assert.deepEqual(taskDirsUnderRuns(workDir), [], 'no task directory should exist');
    assert.deepEqual(leftoverTmpFiles(workDir), [], 'no temp file should be left behind');
  });

  test('task:new --kind pr_review: F4 repro - a bad --parent (FOREIGN KEY failure inside the transaction) leaves no task directory and no temp file behind', () => {
    // This is the blind adversarial reviewer's exact repro: --parent names a
    // task id that does not exist, so insertTask's FOREIGN KEY REFERENCES
    // tasks(id) fails partway through the withImmediateTransaction block -
    // after the diff has already been captured and redacted to a temp file,
    // but (per the F4 fix) before anything is ever created under
    // `<runs>/<taskId>/`.
    const { workDir, dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);
    const before = taskCount(dbPath);

    const result = cli(newTaskArgs(['--parent', 't_doesnotexist0000000000']), {
      GH_STUB_TITLE: 'Fix the widget',
      GH_STUB_BODY: 'This fixes the widget that was broken.',
      GH_STUB_DIFF: 'diff --git a/feature.mjs b/feature.mjs\n+console.log("hi");\n',
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /FOREIGN KEY constraint failed/);
    assert.equal(taskCount(dbPath), before, 'no task row should have been inserted');
    assert.deepEqual(taskDirsUnderRuns(workDir), [], 'no task directory should have been created');
    assert.deepEqual(leftoverTmpFiles(workDir), [], 'the temp diff file must be cleaned up on a failed transaction');
  });

  test('task:new --kind pr_review: gh pr view JSON missing baseRefOid/headRefOid stores null instead of crashing', () => {
    const { dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);

    const result = cli(newTaskArgs(), { GH_STUB_OMIT_SHAS: '1' });
    assert.equal(result.code, 0, result.stderr);
    const taskId = result.stdout.trim();

    const shown = cli(['task:show', taskId, '--json']);
    assert.equal(shown.code, 0, shown.stderr);
    const view = JSON.parse(shown.stdout);
    assert.equal(view.task.base_sha, null);
    assert.equal(view.task.head_sha, null);
    // base_commit falls back to the (also missing) baseRefOid, so it too is
    // null rather than the string "undefined" or a thrown TypeError.
    assert.equal(view.task.base_commit, null);
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

  test('task:new --kind pr_review: F5 repro - a PR body with an embedded NUL byte is not silently truncated', () => {
    // node:sqlite's TEXT bind truncates a JS string at its first embedded
    // NUL byte with no error (db.prepare(...).run('abc\0def') reads back as
    // 'abc') - see test/ledger.test.mjs for the underlying repro in
    // isolation. GH_STUB_BODY can't carry a raw NUL byte itself (an OS
    // environment variable is a NUL-terminated C string), so the marker
    // "<<NUL>>" stands in for it and the stub swaps it for a real NUL - see
    // test/fixtures/gh-stub.mjs.
    const { dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);

    const result = cli(newTaskArgs(), {
      GH_STUB_TITLE: 'NUL byte repro',
      GH_STUB_BODY: 'textbefore<<NUL>>textafter',
      GH_STUB_BODY_NUL_MARKER: '<<NUL>>',
    });
    assert.equal(result.code, 0, result.stderr);
    const taskId = result.stdout.trim();

    const briefs = briefMessagesFor(dbPath, taskId);
    assert.equal(briefs.length, 1);
    // Both sides of where the NUL was must survive - a truncating bind
    // would keep only 'textbefore' and silently drop 'textafter' entirely.
    assert.match(briefs[0].body, /textbefore/);
    assert.match(briefs[0].body, /textafter/);
    assert.ok(!briefs[0].body.includes('\0'), 'the NUL byte itself should be stripped, not stored');
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

  test('task:new --kind pr_review: a 5 MB diff with a planted AWS key is captured in full and the key is redacted (fast, always on)', () => {
    const { workDir, dbPath, cli } = makeHarness();
    assert.equal(cli(['init']).code, 0);

    const diffPath5mb = join(workDir, 'five-mb.diff');
    const targetBytes = 5 * 1024 * 1024;
    writeLargeDiffFixture(diffPath5mb, targetBytes, `+  const key = "${AKIA_KEY}"; // pretend leaked credential`);
    assert.ok(statSync(diffPath5mb).size >= targetBytes);

    const result = cli(newTaskArgs(), { GH_STUB_DIFF_FILE: diffPath5mb });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /warning:.*over the 2000000 byte guard/);
    const taskId = result.stdout.trim();

    const finalDiffPath = join(workDir, '.cortex', 'runs', taskId, 'pr.diff');
    const written = readFileSync(finalDiffPath, 'utf8');
    assert.ok(!written.includes(AKIA_KEY), 'the AWS key must be redacted, not passed through because the diff is large');
    assert.match(written, /\[REDACTED\]/);
    // Only the one secret line's length changed - still essentially the
    // full 5 MB, never truncated.
    assert.ok(Buffer.byteLength(written, 'utf8') > targetBytes - 1000);

    const shown = cli(['task:show', taskId, '--json']);
    const view = JSON.parse(shown.stdout);
    assert.match(view.task.notes ?? '', /pr_diff_oversized:\d+/);
    assert.deepEqual(leftoverTmpFiles(workDir), []);
  });

  // F6 repro at the reported scale: a 70 MB diff piped through the old
  // buffered spawnSync call (maxBuffer: 64 MiB) failed with ENOBUFS before
  // the 2,000,000 byte size guard ever got a chance to apply - see this
  // task's F4/F6 write-up. Generating and redact-scanning 70 MB is I/O
  // bound, not CPU bound, and measured well under the "seconds, not
  // minutes" target locally; CORTEX_TEST_SKIP_LARGE_DIFF=1 is the escape
  // hatch this task asked for in case a slower CI runner needs it.
  const skip70mb = process.env.CORTEX_TEST_SKIP_LARGE_DIFF === '1';
  test(
    'task:new --kind pr_review: F6 repro - a 70 MB diff no longer hits spawnSync ENOBUFS; exits 0, written in full, planted key redacted',
    { skip: skip70mb && 'set CORTEX_TEST_SKIP_LARGE_DIFF=1 to skip this on a slow CI runner' },
    () => {
      const { workDir, dbPath, cli } = makeHarness();
      assert.equal(cli(['init']).code, 0);

      const diffPath70mb = join(workDir, 'seventy-mb.diff');
      const targetBytes = 70 * 1024 * 1024;
      writeLargeDiffFixture(diffPath70mb, targetBytes, `+  const key = "${AKIA_KEY}"; // pretend leaked credential`);
      const rawBytes = statSync(diffPath70mb).size;
      assert.ok(rawBytes >= targetBytes, 'fixture must actually reach 70 MB to exercise the repro');

      const result = cli(newTaskArgs(), { GH_STUB_DIFF_FILE: diffPath70mb });
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /ENOBUFS/);
      assert.match(result.stderr, /warning:.*over the 2000000 byte guard/);
      const taskId = result.stdout.trim();

      const finalDiffPath = join(workDir, '.cortex', 'runs', taskId, 'pr.diff');
      const finalBytes = statSync(finalDiffPath).size;
      // Redaction can only shrink or hold the byte count (the AKIA key,
      // once matched, is replaced by the shorter literal '[REDACTED]'), so
      // this allows for that one substitution while still confirming the
      // diff was captured essentially in full, not truncated or dropped.
      assert.ok(finalBytes > rawBytes - 1000, `expected ~${rawBytes} bytes, got ${finalBytes}`);

      const shown = cli(['task:show', taskId, '--json']);
      const view = JSON.parse(shown.stdout);
      assert.match(view.task.notes ?? '', /pr_diff_oversized:\d+/);

      // Reading the whole 70 MB result back into memory here is fine - the
      // "no whole-file readFileSync" constraint (F6) is on task:new's own
      // production code path, not on this test's own verification step.
      const finalText = readFileSync(finalDiffPath, 'utf8');
      assert.ok(!finalText.includes(AKIA_KEY), 'the planted AWS key must be redacted in the final file');
      assert.match(finalText, /\[REDACTED\]/);

      assert.deepEqual(leftoverTmpFiles(workDir), []);
    }
  );
}
