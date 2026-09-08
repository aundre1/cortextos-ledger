import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir, runCli } from './helpers.mjs';
import { insertTask, insertMessage, insertEscalation, listVerdicts, getTask } from '../src/ledger.mjs';
import {
  buildReviewerBrief,
  validateVerdict,
  detectBlindnessBreach,
  storeVerdict,
  adjudicate,
  triageNote,
} from '../src/review.mjs';

async function migrated() {
  const db = openDb(makeTempDb());
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  return { db, config };
}

function validVerdict(overrides = {}) {
  return {
    verdict_version: '1',
    decision: 'approve',
    summary: 'Looks fine.',
    findings: [],
    tests_touched: false,
    tests_touched_justified: null,
    scope_exceeded: false,
    confidence: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateVerdict
// ---------------------------------------------------------------------------

test('validateVerdict: valid approve with no findings passes', () => {
  const { ok, errors } = validateVerdict(validVerdict());
  assert.equal(ok, true, errors.join('; '));
});

test('validateVerdict: decision must be in the enum', () => {
  const { ok, errors } = validateVerdict(validVerdict({ decision: 'bogus' }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('decision')));
});

test('validateVerdict: changes_requested with no major/blocker finding fails', () => {
  const { ok, errors } = validateVerdict(
    validVerdict({ decision: 'changes_requested', findings: [{ id: 'F1', severity: 'nit', file: 'a.js', claim: 'x' }] })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('blocker or major')));
});

test('validateVerdict: reject with a blocker finding and evidence passes', () => {
  const { ok, errors } = validateVerdict(
    validVerdict({
      decision: 'reject',
      findings: [{ id: 'F1', severity: 'blocker', file: 'a.js', claim: 'broken', evidence: 'line 3' }],
    })
  );
  assert.equal(ok, true, errors.join('; '));
});

test('validateVerdict: approve with a major finding fails', () => {
  const { ok, errors } = validateVerdict(
    validVerdict({ decision: 'approve', findings: [{ id: 'F1', severity: 'major', file: 'a.js', claim: 'x', evidence: 'y' }] })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('approve allows only')));
});

test('validateVerdict: finding missing file or claim fails', () => {
  const { ok, errors } = validateVerdict(
    validVerdict({ decision: 'changes_requested', findings: [{ id: 'F1', severity: 'major', evidence: 'y' }] })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('missing file')));
  assert.ok(errors.some((e) => e.includes('missing claim')));
});

test('validateVerdict: blocker/major finding without evidence fails', () => {
  const { ok, errors } = validateVerdict(
    validVerdict({ decision: 'changes_requested', findings: [{ id: 'F1', severity: 'major', file: 'a.js', claim: 'x' }] })
  );
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('requires evidence')));
});

test('validateVerdict: confidence out of range fails', () => {
  assert.equal(validateVerdict(validVerdict({ confidence: 1.5 })).ok, false);
  assert.equal(validateVerdict(validVerdict({ confidence: -0.1 })).ok, false);
  assert.equal(validateVerdict(validVerdict({ confidence: 0 })).ok, true);
});

// Phase 1a real-batch fix F2: an over-cap summary is no longer a validation
// failure - see storeVerdict's own truncation tests below - only an empty
// summary still fails here.
test('validateVerdict: summary over 600 chars is NOT a validation failure any more (storeVerdict truncates it instead)', () => {
  const { ok, errors } = validateVerdict(validVerdict({ summary: 'x'.repeat(601) }));
  assert.equal(ok, true, errors.join('; '));
});

test('validateVerdict: an empty summary still fails', () => {
  const { ok, errors } = validateVerdict(validVerdict({ summary: '' }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('summary is required')));
});

test('validateVerdict: testsTouchedExpected requires tests_touched true and a justification', () => {
  const bad = validateVerdict(validVerdict({ tests_touched: false }), { testsTouchedExpected: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('tests_touched must be true')));

  const stillBad = validateVerdict(validVerdict({ tests_touched: true, tests_touched_justified: null }), {
    testsTouchedExpected: true,
  });
  assert.equal(stillBad.ok, false);
  assert.ok(stillBad.errors.some((e) => e.includes('tests_touched_justified')));

  const good = validateVerdict(validVerdict({ tests_touched: true, tests_touched_justified: true, summary: 'Edited test X because it asserted the old behaviour.' }), {
    testsTouchedExpected: true,
  });
  assert.equal(good.ok, true, good.errors.join('; '));
});

// ---------------------------------------------------------------------------
// detectBlindnessBreach
// ---------------------------------------------------------------------------

test('detectBlindnessBreach: true on a builder/ or reasoning.md line, false otherwise, false if missing', () => {
  const dir = makeTempDir();
  const clean = join(dir, 'clean.jsonl');
  writeFileSync(clean, '{"type":"tool.call","tool":"read","args_summary":"path=reviewer/patch.diff"}\n');
  assert.equal(detectBlindnessBreach(clean), false);

  const dirty = join(dir, 'dirty.jsonl');
  writeFileSync(dirty, '{"type":"tool.call","tool":"read","args_summary":"path=builder/out.txt"}\n');
  assert.equal(detectBlindnessBreach(dirty), true);

  const reasoning = join(dir, 'reasoning.jsonl');
  writeFileSync(reasoning, '{"type":"tool.call","args_summary":"path=some/reasoning.md"}\n');
  assert.equal(detectBlindnessBreach(reasoning), true);

  assert.equal(detectBlindnessBreach(join(dir, 'missing.jsonl')), false);
});

// ---------------------------------------------------------------------------
// buildReviewerBrief
// ---------------------------------------------------------------------------

test('buildReviewerBrief: never leaks reasoning.md or builder out.txt content', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'Fix bug', task_class: 'ci', arm: 'tri', base_commit: 'abc123', branch: 'br' });
  insertMessage(db, { task_id: task.id, sender: 'architect', recipient: 'builder', kind: 'brief', body: 'Fix the off by one error.' });

  const builderDir = join(config.runs, task.id, 'builder');
  mkdirSync(builderDir, { recursive: true });
  writeFileSync(join(builderDir, 'reasoning.md'), 'SENTINEL_SHOULD_NOT_LEAK: my secret plan');
  writeFileSync(join(builderDir, 'out.txt'), 'SENTINEL_OUT_SHOULD_NOT_LEAK builder stdout');
  writeFileSync(join(builderDir, 'patch.diff'), '--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-old\n+new\n');

  const { path, markdown } = buildReviewerBrief(db, config, { taskId: task.id, reviewer: 'reviewer' });
  assert.ok(existsSync(path));
  assert.ok(!markdown.includes('SENTINEL_SHOULD_NOT_LEAK'));
  assert.ok(!markdown.includes('SENTINEL_OUT_SHOULD_NOT_LEAK'));
  assert.ok(markdown.includes('Fix the off by one error.'));
  assert.ok(markdown.includes('old'));
  assert.ok(markdown.includes('abc123'));
  assert.ok(existsSync(join(config.runs, task.id, 'reviewer', 'patch.diff')));
  db.close();
});

test('buildReviewerBrief: names the exact absolute verdict.json path (Phase 1a dry-run finding: a vague brief let a reviewer write it one directory too high)', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });

  const { markdown } = buildReviewerBrief(db, config, { taskId: task.id, reviewer: 'reviewer' });
  const expectedPath = join(config.runs, task.id, 'reviewer', 'verdict.json');
  assert.ok(markdown.includes(expectedPath), `brief must name the exact output path ${expectedPath}`);
  assert.ok(markdown.includes('# Output'));
  db.close();
});

test('buildReviewerBrief: warns that the 600-character summary cap is strictly enforced (Phase 1a dry run: 3 real verdicts rejected for exceeding it)', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });

  const { markdown } = buildReviewerBrief(db, config, { taskId: task.id, reviewer: 'reviewer' });
  assert.ok(markdown.includes('strictly enforced'));
  assert.ok(markdown.includes('600 charact'));
  db.close();
});

test('buildReviewerBrief: pr_review task gets prompts/pr-triage-reviewer.md, every other task kind gets prompts/reviewer.md', async () => {
  const { db, config } = await migrated();

  const prTask = insertTask(db, {
    repo: 'o/n', title: 'Triage PR #7', task_class: 'pr-triage', arm: 'tri', kind: 'pr_review',
    pr_number: 7, base_commit: 'deadbeef', branch: 'feature/x',
  });
  const { markdown: prMarkdown } = buildReviewerBrief(db, config, { taskId: prTask.id, reviewer: 'reviewer' });
  assert.ok(prMarkdown.includes('Role: PR Triage Reviewer'));
  assert.ok(!prMarkdown.includes('Role: Blind Reviewer'));
  assert.ok(!prMarkdown.includes("builder/"), 'PR triage brief must not mention the builder/ directory - no builder run exists in this mode');

  const ciTask = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const { markdown: ciMarkdown } = buildReviewerBrief(db, config, { taskId: ciTask.id, reviewer: 'reviewer' });
  assert.ok(ciMarkdown.includes('Role: Blind Reviewer'));
  assert.ok(!ciMarkdown.includes('Role: PR Triage Reviewer'));

  db.close();
});

test('buildReviewerBrief: pr_review task reads the diff from <runs>/<task>/pr.diff, never builder/patch.diff (docs/review-protocol.md "PR triage mode")', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, {
    repo: 'o/n', title: 'Triage PR #7', task_class: 'pr-triage', arm: 'tri', kind: 'pr_review',
    pr_number: 7, base_commit: 'deadbeef', branch: 'feature/x',
  });
  insertMessage(db, { task_id: task.id, sender: 'ledger', recipient: 'architect', kind: 'brief', body: 'PR title\n\nPR body' });

  mkdirSync(join(config.runs, task.id), { recursive: true });
  writeFileSync(join(config.runs, task.id, 'pr.diff'), '--- a/real_file.mjs\n+++ b/real_file.mjs\n@@ -1 +1 @@\n-old\n+new\n');

  const { markdown } = buildReviewerBrief(db, config, { taskId: task.id, reviewer: 'reviewer' });
  assert.ok(markdown.includes('real_file.mjs'), 'the actual PR diff content must be in the brief');
  assert.ok(markdown.includes('PR title'));
  assert.ok(!markdown.includes('no diff found'));
  assert.ok(existsSync(join(config.runs, task.id, 'reviewer', 'patch.diff')), 'pr.diff is copied into the reviewer dir under the same patch.diff name');
  db.close();
});

test('buildReviewerBrief: includes touched test files section when a test_edit escalation exists', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  insertEscalation(db, { task_id: task.id, reason: 'test_edit', severity: 'warn', detail: 'test/x.test.mjs' });

  const { markdown } = buildReviewerBrief(db, config, { taskId: task.id, reviewer: 'reviewer' });
  assert.ok(markdown.includes('Touched test files'));
  assert.ok(markdown.includes('test/x.test.mjs'));
  assert.ok(markdown.includes('justified by the issue'));
  db.close();
});

// ---------------------------------------------------------------------------
// storeVerdict
// ---------------------------------------------------------------------------

test('storeVerdict: stores a valid blind verdict with challenge_seq 0 and copies the task arm', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const result = storeVerdict(db, config, {
    taskId: task.id, runId: null, reviewer: 'reviewer', provider: 'p', model: 'm',
    verdictObj: validVerdict(), challenge: false,
  });
  assert.equal(result.code, 0, result.errors.join('; '));
  const stored = listVerdicts(db, task.id)[0];
  assert.equal(stored.challenge_seq, 0);
  assert.equal(stored.arm, 'tri');
  assert.equal(stored.blind, 1);
  db.close();
});

test('storeVerdict: invalid verdict returns code 5 and stores nothing', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const result = storeVerdict(db, config, {
    taskId: task.id, runId: null, reviewer: 'reviewer', provider: 'p', model: 'm',
    verdictObj: validVerdict({ decision: 'bogus' }), challenge: false,
  });
  assert.equal(result.code, 5);
  assert.equal(listVerdicts(db, task.id).length, 0);
  db.close();
});

// Phase 1a real-batch fix F2: proves both halves of the fix at once - a
// 967 character summary (the exact length one of the three real Phase 1a
// dry-run verdicts came back at) is stored truncated to the documented cap
// with the escalation and the original length recorded, while a verdict
// with an actual semantic problem still exits 5 and stores nothing, exactly
// as before this fix.

test('storeVerdict: a 967 character summary is stored truncated to 600 chars, at a word boundary, with a warn escalation recording reviewer/model/original length', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const longSummary = 'word '.repeat(200).slice(0, 967); // 967 chars, real whitespace throughout
  assert.equal(longSummary.length, 967);

  const result = storeVerdict(db, config, {
    taskId: task.id, runId: null, reviewer: 'reviewer', provider: 'nvidia', model: 'nvidia/moonshotai/kimi-k3',
    verdictObj: validVerdict({ summary: longSummary }), challenge: false,
  });
  assert.equal(result.code, 0, result.errors.join('; '));

  const stored = listVerdicts(db, task.id)[0];
  assert.equal(stored.summary_truncated_from, 967);
  const storedSummary = JSON.parse(stored.findings_json).summary;
  assert.ok(storedSummary.length <= 600, `stored summary is ${storedSummary.length} chars`);
  assert.equal(storedSummary.endsWith(' '), false, 'trailing whitespace is trimmed');
  assert.equal(longSummary.startsWith(storedSummary), true, 'truncated at a word boundary, not mid-word');

  const escalations = db.prepare('SELECT * FROM escalations WHERE task_id = ?').all(task.id);
  const truncationEscalation = escalations.find((e) => e.reason === 'verdict_truncated');
  assert.ok(truncationEscalation, 'expected a verdict_truncated escalation');
  assert.equal(truncationEscalation.severity, 'warn');
  assert.match(truncationEscalation.detail, /reviewer/);
  assert.match(truncationEscalation.detail, /nvidia\/moonshotai\/kimi-k3/);
  assert.match(truncationEscalation.detail, /967/);
  db.close();
});

test('storeVerdict: a genuine semantic violation (reject with no blocker/major finding) still exits 5 and stores nothing, even with an over-length summary', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const result = storeVerdict(db, config, {
    taskId: task.id, runId: null, reviewer: 'reviewer', provider: 'p', model: 'm',
    verdictObj: validVerdict({
      decision: 'reject',
      summary: 'x'.repeat(700),
      findings: [{ id: 'F1', severity: 'nit', file: 'src/x.mjs', claim: 'a nit' }],
    }),
    challenge: false,
  });
  assert.equal(result.code, 5);
  assert.ok(result.errors.some((e) => e.includes('requires at least one blocker or major finding')));
  assert.equal(listVerdicts(db, task.id).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM escalations WHERE task_id = ?').get(task.id).c, 0);
  db.close();
});

// CLI-level (docs/state-machine.md exit code table: "5 | Verdict JSON
// invalid"), as opposed to the storeVerdict-level test above - exercises
// bin/cortexctl.mjs's own argv-to-exit-code path for `verdict`, including
// the case the CLI handler itself catches (a file that is not valid JSON at
// all, never reaching storeVerdict).
test('verdict (CLI): a file that is not valid JSON exits 5 with reason verdict_invalid', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const taskId = runCli([
    'task:new', '--db', dbPath,
    '--repo', 'o/n', '--title', 'T', '--class', 'ci', '--arm', 'tri',
  ]).stdout.trim();

  const badFile = join(makeTempDir(), 'verdict.json');
  writeFileSync(badFile, 'this is not json{{{');

  const result = runCli([
    'verdict', '--db', dbPath, '--task', taskId, '--run', 'r_doesnotexist',
    '--reviewer', 'reviewer', '--provider', 'p', '--model', 'm', '--file', badFile,
  ]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /verdict_invalid/);
});

test('verdict (CLI): well-formed JSON that fails schema validation exits 5', () => {
  const dbPath = makeTempDb();
  assert.equal(runCli(['init', '--db', dbPath]).code, 0);
  const taskId = runCli([
    'task:new', '--db', dbPath,
    '--repo', 'o/n', '--title', 'T', '--class', 'ci', '--arm', 'tri',
  ]).stdout.trim();

  const badFile = join(makeTempDir(), 'verdict.json');
  writeFileSync(badFile, JSON.stringify({ decision: 'bogus', summary: '', findings: [], confidence: 2 }));

  const result = runCli([
    'verdict', '--db', dbPath, '--task', taskId, '--run', 'r_doesnotexist',
    '--reviewer', 'reviewer', '--provider', 'p', '--model', 'm', '--file', badFile,
  ]);
  assert.equal(result.code, 5);
  assert.match(result.stderr, /verdict_invalid/);
});

test('storeVerdict: a duplicate challenge_seq 0 verdict from the same reviewer is refused with code 6', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const first = storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false,
  });
  assert.equal(first.code, 0);
  const second = storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false,
  });
  assert.equal(second.code, 6);
  assert.equal(listVerdicts(db, task.id).length, 1);
  db.close();
});

test('storeVerdict: blind flips to 0 and a verdict_invalid warn escalation is written when reviewer events show a builder/ read', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  const eventsPath = join(makeTempDir(), 'events.jsonl');
  writeFileSync(eventsPath, '{"type":"tool.call","args_summary":"path=builder/reasoning.md"}\n');

  const result = storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(),
    challenge: false, reviewerEventsPath: eventsPath,
  });
  assert.equal(result.code, 0);
  const stored = listVerdicts(db, task.id)[0];
  assert.equal(stored.blind, 0);
  const escalations = db.prepare("SELECT * FROM escalations WHERE task_id = ? AND reason = 'verdict_invalid'").all(task.id);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].severity, 'warn');
  db.close();
});

test('storeVerdict: challenge without a preceding architect challenge message is refused with code 3 and escalation challenge_limit', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  storeVerdict(db, config, { taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false });

  const result = storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: true,
  });
  assert.equal(result.code, 3);
  const escalations = db.prepare("SELECT * FROM escalations WHERE task_id = ? AND reason = 'challenge_limit'").all(task.id);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].severity, 'halt');
  assert.equal(getTask(db, task.id).status, 'input_required');
  db.close();
});

test('storeVerdict: a properly preceded challenge is accepted with challenge_seq 1; a second challenge is refused with code 3', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  storeVerdict(db, config, { taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: false });
  insertMessage(db, { task_id: task.id, sender: 'architect', recipient: 'reviewer', kind: 'challenge', body: 'reconsider finding F1' });

  const challenged = storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: true,
  });
  assert.equal(challenged.code, 0, challenged.errors.join('; '));
  assert.equal(listVerdicts(db, task.id).find((v) => v.id === challenged.verdictId).challenge_seq, 1);

  // A second challenge exceeds challenge_cycles_max (default 1): exit 3.
  insertMessage(db, { task_id: task.id, sender: 'architect', recipient: 'reviewer', kind: 'challenge', body: 'again' });
  const secondChallenge = storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm', verdictObj: validVerdict(), challenge: true,
  });
  assert.equal(secondChallenge.code, 3);
  db.close();
});

// ---------------------------------------------------------------------------
// adjudicate
// ---------------------------------------------------------------------------

test('adjudicate: updates the latest verdict, defects_escaped, and inserts an intervention row', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'tri' });
  storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm',
    verdictObj: validVerdict({ decision: 'changes_requested', findings: [{ id: 'F1', severity: 'major', file: 'a.js', claim: 'x', evidence: 'y' }] }),
    challenge: false,
  });

  const result = adjudicate(db, { taskId: task.id, real: 1, noise: 0, escaped: 2, minutes: 5, note: 'checked by hand' });
  const verdict = listVerdicts(db, task.id)[0];
  assert.equal(verdict.findings_real, 1);
  assert.equal(verdict.findings_noise, 0);
  assert.equal(getTask(db, task.id).defects_escaped, 2);
  const intervention = db.prepare('SELECT * FROM human_interventions WHERE id = ?').get(result.intervention.id);
  assert.equal(intervention.kind, 'adjudicate');
  assert.equal(intervention.minutes, 5);
  db.close();
});

test('adjudicate: works for a control-arm task with no verdict at all', async () => {
  const { db } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'T', task_class: 'ci', arm: 'control' });
  const result = adjudicate(db, { taskId: task.id, real: 0, noise: 0, escaped: 0, note: 'no findings, control arm' });
  assert.equal(result.verdictId, null);
  assert.ok(result.intervention.id);
  db.close();
});

// ---------------------------------------------------------------------------
// triageNote
// ---------------------------------------------------------------------------

test('triageNote: merges two reviewers into agreed findings, disagreements, and ledger ids', async () => {
  const { db, config } = await migrated();
  const task = insertTask(db, { repo: 'o/n', title: 'PR triage', task_class: 'pr-triage', arm: 'tri', kind: 'pr_review', pr_number: 42 });

  storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer', provider: 'p', model: 'm',
    verdictObj: validVerdict({
      decision: 'changes_requested',
      findings: [
        { id: 'F1', severity: 'major', file: 'a.js', line: 10, claim: 'off by one', evidence: 'x' },
        { id: 'F2', severity: 'minor', file: 'b.js', line: 5, claim: 'style nit', evidence: 'y' },
      ],
    }),
    challenge: false,
  });
  storeVerdict(db, config, {
    taskId: task.id, reviewer: 'reviewer_b', provider: 'p2', model: 'm2',
    verdictObj: validVerdict({
      decision: 'changes_requested',
      findings: [{ id: 'F1', severity: 'major', file: 'a.js', line: 10, claim: 'off by one', evidence: 'x' }],
    }),
    challenge: false,
  });

  const note = triageNote(db, config, task.id);
  assert.match(note, /Agreed findings/);
  assert.match(note, /off by one/);
  assert.match(note, /Disagreements/);
  assert.match(note, /style nit/);
  assert.match(note, new RegExp(task.id));
  db.close();
});
