import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.mjs';
import { makeTempDb, makeTempGitRepo, makeTempDir } from './helpers.mjs';
import { insertTask, listEscalations, getTask, upsertQuota } from '../src/ledger.mjs';
import { transition } from '../src/limits.mjs';
import { scan, PATTERNS, SECRET_FILENAMES } from '../src/guards/secrets-scan.mjs';
import { preflight } from '../src/guards/preflight.mjs';
import {
  filesTouched,
  matchesAny,
  testEditDetection,
  toolFailureStreak,
  scopeMarker,
  missingPatch,
} from '../src/guards/postrun.mjs';

const CONFIG = {
  limits: {
    builder_attempts_max: 3, challenge_cycles_max: 1, wallclock_s: 5400,
    spend_usd: 5.0, files_touched_max: 10, stall_s: 900,
  },
  providers: {
    nvidia: { windows: [{ kind: 'minute', limit_requests: 40 }], public_only: true },
  },
  test_patterns: ['**/*.test.*', '**/*_test.*', '**/__tests__/**', '**/tests/**', '**/spec/**'],
};

async function freshDb() {
  const db = openDb(makeTempDb());
  await migrate(db);
  return db;
}

// ---------------------------------------------------------------------------
// secrets-scan
// ---------------------------------------------------------------------------

test('secrets-scan: finds a planted key by pattern, reports path+line, never the value', () => {
  const dir = makeTempDir();
  const planted = 'sk-ant-THISISASECRETVALUETHATSHOULDNEVERAPPEAR';
  writeFileSync(join(dir, 'config.js'), `const key = "${planted}";\n`);

  const findings = scan(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'config.js');
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].pattern, 'anthropic_key');

  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes(planted), 'the matched secret value must never appear in the finding');
});

test('secrets-scan: flags secret file names even with innocuous contents', () => {
  const dir = makeTempDir();
  writeFileSync(join(dir, '.env'), 'FOO=bar\n');
  writeFileSync(join(dir, 'credentials.json'), '{}');
  writeFileSync(join(dir, 'id_rsa.pem'), 'not actually a key\n');

  const findings = scan(dir);
  const paths = findings.map((f) => f.path).sort();
  assert.deepEqual(paths, ['.env', 'credentials.json', 'id_rsa.pem']);
  assert.ok(findings.every((f) => f.pattern === 'secret_filename'));
});

test('secrets-scan: skips .git, node_modules, .cortex and binaries', () => {
  const dir = makeTempDir();
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), 'sk-ant-hiddensecretvalue12345\n');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'sk-ant-hiddensecretvalue12345\n');
  mkdirSync(join(dir, '.cortex'), { recursive: true });
  writeFileSync(join(dir, '.cortex', 'ledger.db'), 'sk-ant-hiddensecretvalue12345\n');

  const binary = Buffer.concat([Buffer.from('sk-ant-'), Buffer.from([0, 1, 2, 3]), Buffer.from('binaryjunk')]);
  writeFileSync(join(dir, 'blob.bin'), binary);

  const findings = scan(dir);
  assert.deepEqual(findings, []);
});

test('secrets-scan: PATTERNS and SECRET_FILENAMES are exported and non-empty', () => {
  assert.ok(Array.isArray(PATTERNS) && PATTERNS.length > 5);
  assert.ok(Array.isArray(SECRET_FILENAMES) && SECRET_FILENAMES.includes('.env'));
});

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

test('preflight: clean worktree, no secrets, no quota configured -> ok', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const result = await preflight(db, CONFIG, { worktree: dir, provider: 'openai', model: 'gpt-x' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  db.close();
});

test('preflight: dirty tracked worktree refuses with exit 2 and writes a halt escalation', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  writeFileSync(join(dir, 'README.md'), 'changed\n');
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');

  const result = await preflight(db, CONFIG, {
    worktree: dir, provider: 'openai', model: 'gpt-x', taskId: task.id,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.equal(result.reason, 'dirty_worktree');

  const escalations = listEscalations(db, task.id);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, 'dirty_worktree');
  assert.equal(escalations[0].severity, 'halt');
  assert.equal(getTask(db, task.id).status, 'input_required');
  db.close();
});

test('preflight: --allow-dirty passes and records the override in task notes', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  writeFileSync(join(dir, 'README.md'), 'changed\n');
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');

  const result = await preflight(db, CONFIG, {
    worktree: dir, provider: 'openai', model: 'gpt-x', taskId: task.id, allowDirty: true,
  });
  assert.equal(result.ok, true);
  assert.match(getTask(db, task.id).notes ?? '', /allow_dirty/);
  db.close();
});

test('preflight: untracked files pass by default but refuse under --strict', async () => {
  const { dir } = makeTempGitRepo();
  writeFileSync(join(dir, 'scratch.txt'), 'new file\n');
  const db = await freshDb();

  const lenient = await preflight(db, CONFIG, { worktree: dir, provider: 'openai', model: 'gpt-x' });
  assert.equal(lenient.ok, true);

  const strict = await preflight(db, CONFIG, { worktree: dir, provider: 'openai', model: 'gpt-x', strict: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.reason, 'dirty_worktree');
  db.close();
});

test('preflight: secrets in the tree refuse with exit 2, escalation, and never leak the value', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const planted = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  writeFileSync(join(dir, 'notes.txt'), `token: ${planted}\n`);
  execFileSync('git', ['add', 'notes.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'add secret'], { cwd: dir });

  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');

  const result = await preflight(db, CONFIG, {
    worktree: dir, provider: 'openai', model: 'gpt-x', taskId: task.id,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.equal(result.reason, 'secrets');
  assert.ok(!JSON.stringify(result).includes(planted));

  const escalations = listEscalations(db, task.id);
  assert.equal(escalations[0].reason, 'secrets');
  assert.ok(!JSON.stringify(escalations).includes(planted), 'the escalation detail must never contain the secret value');
  db.close();
});

test('preflight: public_only provider without --public refuses with exit 4', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const result = await preflight(db, CONFIG, { worktree: dir, provider: 'nvidia', model: 'nim-x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 4);
  assert.equal(result.reason, 'public_only');
  db.close();
});

test('preflight: quota exhaustion refuses with exit 4 and escalation reason quota (not public_only)', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  upsertQuota(db, { provider: 'google', window_kind: 'day', limit_requests: 0, used_requests: 0 });
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');

  const result = await preflight(db, CONFIG, {
    worktree: dir, provider: 'google', model: null, taskId: task.id,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 4);
  assert.equal(result.reason, 'quota');

  const escalations = listEscalations(db, task.id);
  assert.equal(escalations[0].reason, 'quota');
  db.close();
});

// ---------------------------------------------------------------------------
// preflight: command resolution (docs/adapters.md "Windows command
// resolution", docs/guards.md "Command resolution")
// ---------------------------------------------------------------------------

test('preflight: no --adapter given -> command resolution is skipped entirely', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const result = await preflight(db, CONFIG, { worktree: dir, provider: 'openai', model: 'gpt-x' });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('preflight: adapter "fake" is never checked, even injected as win32 with an empty PATH', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const result = await preflight(db, CONFIG, {
    worktree: dir, provider: 'openai', model: 'gpt-x', adapterName: 'fake',
    platform: 'win32', env: { PATH: '' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('preflight: a real adapter on a platform where resolution always succeeds (posix) -> ok', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const result = await preflight(db, CONFIG, {
    worktree: dir, provider: 'openai', model: 'gpt-x', adapterName: 'claude', platform: 'linux',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('preflight: injected win32 with nothing on PATH -> refuses exit 1, reason command_not_found, no escalation row', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const task = insertTask(db, { repo: 'o/n', title: 't', task_class: 'ci', arm: 'control' });
  transition(db, task.id, 'working');

  const result = await preflight(db, CONFIG, {
    worktree: dir, provider: 'openai', model: 'gpt-x', taskId: task.id,
    adapterName: 'opencode', platform: 'win32', env: { PATH: '' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.reason, 'command_not_found');
  assert.match(result.detail, /opencode/);

  // No escalation row: docs/ledger.md's escalations.reason enum has no
  // command_not_found slot, matching the node_version precedent.
  assert.deepEqual(listEscalations(db, task.id), []);
  db.close();
});

test('preflight: config.tools.<adapter> override bypasses PATH resolution entirely, even on injected win32 with an empty PATH', async () => {
  const db = await freshDb();
  const { dir } = makeTempGitRepo();
  const config = { ...CONFIG, tools: { opencode: ['C:/tools/opencode.exe'] } };

  const result = await preflight(db, config, {
    worktree: dir, provider: 'openai', model: 'gpt-x',
    adapterName: 'opencode', platform: 'win32', env: { PATH: '' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  db.close();
});

// ---------------------------------------------------------------------------
// postrun
// ---------------------------------------------------------------------------

test('filesTouched: union of diff against base and untracked files', () => {
  const { dir, baseCommit } = makeTempGitRepo();
  writeFileSync(join(dir, 'README.md'), 'edited\n');
  writeFileSync(join(dir, 'new-file.txt'), 'brand new\n');

  const files = filesTouched(dir, baseCommit).sort();
  assert.deepEqual(files, ['README.md', 'new-file.txt']);
});

test('matchesAny: ** and * glob semantics over forward-slash paths', () => {
  const patterns = ['**/*.test.*', '**/__tests__/**', '**/tests/**'];
  assert.equal(matchesAny('src/foo.test.mjs', patterns), true);
  assert.equal(matchesAny('a/__tests__/b.js', patterns), true);
  assert.equal(matchesAny('a/tests/b.js', patterns), true);
  assert.equal(matchesAny('src/foo.mjs', patterns), false);
});

test('testEditDetection: flags touched test files unless task_class is tests', () => {
  const files = ['src/x.mjs', 'test/x.test.mjs'];
  const hit = testEditDetection(files, CONFIG.test_patterns, 'ci-hardening');
  assert.equal(hit.touched, true);
  assert.deepEqual(hit.files, ['test/x.test.mjs']);

  const exempt = testEditDetection(files, CONFIG.test_patterns, 'tests');
  assert.equal(exempt.touched, false);
});

test('toolFailureStreak: counts the longest run of consecutive tool.result ok=false events', () => {
  const dir = makeTempDir();
  const events = [
    { type: 'tool.call', tool: 'bash' },
    { type: 'tool.result', tool: 'bash', ok: false, error: 'first failure' },
    { type: 'tool.result', tool: 'bash', ok: false, error: 'second failure' },
    { type: 'tool.result', tool: 'bash', ok: true },
    { type: 'tool.result', tool: 'read', ok: false, error: 'x' },
    { type: 'tool.result', tool: 'read', ok: false, error: 'y' },
    { type: 'tool.result', tool: 'read', ok: false, error: 'z' },
  ];
  const path = join(dir, 'events.jsonl');
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const result = toolFailureStreak(path, 3);
  assert.equal(result.hit, true);
  assert.equal(result.streak, 3);
  assert.equal(result.tool, 'read');

  const noHit = toolFailureStreak(path, 4);
  assert.equal(noHit.hit, false);
});

test('toolFailureStreak: missing events.jsonl is not a failure', () => {
  const result = toolFailureStreak(join(makeTempDir(), 'events.jsonl'), 3);
  assert.equal(result.hit, false);
  assert.equal(result.streak, 0);
});

test('scopeMarker: detects SCOPE_EXCEEDED and BLOCKED: lines in out.txt or reasoning.md', () => {
  const dir1 = makeTempDir();
  writeFileSync(join(dir1, 'out.txt'), 'working...\nSCOPE_EXCEEDED touched too many files\n');
  assert.deepEqual(scopeMarker(dir1), {
    found: true, line: 'SCOPE_EXCEEDED touched too many files', file: 'out.txt',
  });

  const dir2 = makeTempDir();
  writeFileSync(join(dir2, 'reasoning.md'), 'BLOCKED: bash exit 1\n');
  const found2 = scopeMarker(dir2);
  assert.equal(found2.found, true);
  assert.equal(found2.file, 'reasoning.md');

  const dir3 = makeTempDir();
  writeFileSync(join(dir3, 'out.txt'), 'all good\n');
  assert.equal(scopeMarker(dir3).found, false);
});

test('missingPatch: true when patch.diff is absent or empty, false when it has content', () => {
  const dir1 = makeTempDir();
  assert.equal(missingPatch(dir1), true);

  const dir2 = makeTempDir();
  writeFileSync(join(dir2, 'patch.diff'), '');
  assert.equal(missingPatch(dir2), true);

  const dir3 = makeTempDir();
  writeFileSync(join(dir3, 'patch.diff'), 'diff --git a/x b/x\n');
  assert.equal(missingPatch(dir3), false);
});
