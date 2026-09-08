// Blind review protocol (docs/review-protocol.md): reviewer brief generation,
// verdict schema validation, blindness detection, verdict storage with the
// challenge-cycle gate, human adjudication, and the PR triage note.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withImmediateTransaction } from './db.mjs';
import {
  getTask,
  listEscalations,
  listVerdicts,
  countVerdicts,
  insertVerdict,
  insertIntervention,
} from './ledger.mjs';
import { escalate } from './limits.mjs';
import { selectForPacket, add as addLesson } from './lessons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const INLINE_DIFF_MAX_BYTES = 60 * 1024;

const VALID_DECISIONS = new Set(['approve', 'changes_requested', 'reject']);
const VALID_SEVERITIES = new Set(['blocker', 'major', 'minor', 'nit']);
const MAJOR_OR_BLOCKER = new Set(['blocker', 'major']);

const VERDICT_SCHEMA_BLOCK = `\`\`\`json
{
  "verdict_version": "1",
  "decision": "approve | changes_requested | reject",
  "summary": "one paragraph, no more than 600 characters",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker | major | minor | nit",
      "file": "src/x.mjs",
      "line": 42,
      "claim": "what is wrong, one sentence",
      "evidence": "the exact lines or behaviour that show it, quoted from the diff",
      "suggested_fix": "optional, one sentence"
    }
  ],
  "tests_touched": false,
  "tests_touched_justified": null,
  "scope_exceeded": false,
  "confidence": 0.0
}
\`\`\``;

const FALLBACK_REVIEWER_PROMPT = `You are a careful, skeptical reviewer. You have not seen the builder's
reasoning, only the issue and the diff. Check the diff against the issue,
line by line. Write a verdict.json matching the schema above. Do not go
looking for the builder's notes; none exist in your allowed directories.
Every claim needs a file and, for blocker/major severity, quoted evidence
from the diff.`;

// ---------------------------------------------------------------------------
// review:brief
// ---------------------------------------------------------------------------

function latestBriefMessage(db, taskId) {
  return db
    .prepare(
      "SELECT * FROM agent_messages WHERE task_id = ? AND kind = 'brief' ORDER BY created_at DESC LIMIT 1"
    )
    .get(taskId);
}

function latestTestEditEscalation(db, taskId) {
  const rows = listEscalations(db, taskId).filter((e) => e.reason === 'test_edit');
  return rows.length ? rows[rows.length - 1] : null;
}

// Phase 1a dry run (grandamenium/cortextos PR #1002 and #874): the brief
// always loaded prompts/reviewer.md, even for a `pr_review` (PR triage) task
// - prompts/pr-triage-reviewer.md exists, is documented in
// docs/review-protocol.md and examples/pr-triage.md as the prompt PR triage
// uses, but nothing ever actually read it. reviewer.md's own "Scope
// discipline" section tells the model to avoid `builder/` and
// `reasoning.md`, which do not exist at all in PR triage mode (there is no
// builder run - see the pr.diff-vs-builder/patch.diff branch above) and so
// is pure noise in that brief; pr-triage-reviewer.md is written for the
// no-builder case directly. Mirrors the diff-sourcing branch above: `kind`
// decides which prompt, same as it already decides which diff.
function readReviewerPrompt(taskKind) {
  const filename = taskKind === 'pr_review' ? 'pr-triage-reviewer.md' : 'reviewer.md';
  const path = join(ROOT, 'prompts', filename);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return FALLBACK_REVIEWER_PROMPT;
}

/**
 * Writes <runs>/<taskId>/reviewer/brief.md. Never reads reasoning.md or the
 * builder's out.txt - only the issue text (ledger or --issue-file), the base
 * commit/branch, the touched-test-file list (if a test_edit escalation
 * exists), the diff, the verdict schema, and the reviewer prompt.
 */
export function buildReviewerBrief(db, config, { taskId, reviewer, issueFile }) {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const reviewerDir = join(config.runs, taskId, reviewer ?? 'reviewer');
  mkdirSync(reviewerDir, { recursive: true });

  const sections = [];

  // Issue text: an explicit --issue-file is the operator overriding the
  // ledger's brief message on purpose, so it wins when given; otherwise fall
  // back to the latest agent_messages row of kind 'brief'.
  let issueText;
  if (issueFile) {
    issueText = readFileSync(issueFile, 'utf8');
  } else {
    const briefMsg = latestBriefMessage(db, taskId);
    issueText = briefMsg ? briefMsg.body : '(no brief message found in the ledger and no --issue-file given)';
  }
  sections.push(`# Issue\n\n${issueText.trim()}`);

  const lessons = selectForPacket(db, config, { taskClass: task.task_class, actor: 'reviewer' });
  if (lessons.length) {
    sections.push(`# Lessons\n\n${lessons.map((l) => `- ${l.lesson} (confidence ${l.confidence})`).join('\n')}`);
  }

  sections.push(`# Base\n\ncommit: ${task.base_commit ?? '-'}\nbranch: ${task.branch ?? '-'}`);

  const testEdit = latestTestEditEscalation(db, taskId);
  if (testEdit) {
    sections.push(
      `# Touched test files\n\n${testEdit.detail ?? '(no detail recorded)'}\n\nVerify each test edit above is justified by the issue.`
    );
  }

  // docs/review-protocol.md "PR triage mode": "For pr_review tasks the diff
  // comes from `gh pr diff <n>` captured by `task:new --pr`" - that diff is
  // written to `<runs>/<taskId>/pr.diff` (docs/cli.md's `task:new` capture),
  // never to `builder/patch.diff` (there is no builder run in PR triage
  // mode). Falling back to the builder's patch.diff for every other task
  // kind, unchanged from before this fix.
  const sourceDiffPath =
    task.kind === 'pr_review' ? join(config.runs, taskId, 'pr.diff') : join(config.runs, taskId, 'builder', 'patch.diff');
  const reviewerDiffPath = join(reviewerDir, 'patch.diff');
  if (existsSync(sourceDiffPath)) {
    copyFileSync(sourceDiffPath, reviewerDiffPath);
    const bytes = statSync(reviewerDiffPath).size;
    if (bytes < INLINE_DIFF_MAX_BYTES) {
      const diffText = readFileSync(reviewerDiffPath, 'utf8');
      sections.push(`# Diff\n\n\`\`\`diff\n${diffText}\n\`\`\``);
    } else {
      sections.push(`# Diff\n\ntoo large to inline (${bytes} bytes); see ${reviewerDiffPath}`);
    }
  } else {
    sections.push(`# Diff\n\nno diff found at ${sourceDiffPath} yet.`);
  }

  // Dry-run finding (Phase 1a, PR #1002 on grandamenium/cortextos): with only
  // the prompts' vague "the run directory named in your brief" to go on, a
  // real reviewer model wrote verdict.json one level too high (taskId/, not
  // taskId/<reviewer>/) - a brief-content gap, not a permission failure (the
  // edit-permission carve-out and the --worktree containment both worked; see
  // docs/adapters.md "opencode: edit permission is per-path, not per-tool
  // (V1)"). Naming the literal absolute path here removes that ambiguity.
  const verdictPath = join(reviewerDir, 'verdict.json');
  sections.push(
    `# Output\n\nWrite your verdict to exactly this absolute path (create it if it does not exist, overwrite it if it does):\n\n\`${verdictPath}\`\n\nDo not write a verdict.json anywhere else.`
  );

  // Phase 1a dry run: three separate real verdicts from this same model
  // (nvidia/moonshotai/kimi-k3, PR #1002 control, PR #1002 tri, PR #874
  // control) each came back at 754, 937, and 967 characters - every one
  // rejected by `cortexctl verdict` (exit 5, "summary must be at most 600
  // characters") despite the schema block above already saying "no more
  // than 600 characters" right on the summary field. A one-clause aside
  // inside a JSON example is not salient enough on its own; this is a
  // separate, blunt paragraph naming the actual failure mode and a concrete
  // target length to aim for instead of the hard ceiling (aiming at the
  // ceiling reliably overshoots it).
  sections.push(
    `# Verdict schema\n\n${VERDICT_SCHEMA_BLOCK}\n\n**\`summary\` is strictly enforced at 600 characters.** A verdict with a longer summary is rejected outright (none of its findings are recorded) - this has happened in real runs. Aim for 3-4 sentences, about 400 characters, not the 600-character ceiling; count before you write the file.`
  );
  sections.push(`# Reviewer instructions\n\n${readReviewerPrompt(task.kind).trim()}`);

  const markdown = sections.join('\n\n');
  const briefPath = join(reviewerDir, 'brief.md');
  writeFileSync(briefPath, markdown);

  return { path: briefPath, markdown };
}

// ---------------------------------------------------------------------------
// validateVerdict
// ---------------------------------------------------------------------------

/**
 * Implements every rule in docs/review-protocol.md's "Verdict schema"
 * section. Returns { ok, errors }; never throws.
 */
export function validateVerdict(obj, { testsTouchedExpected = false } = {}) {
  const errors = [];
  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['verdict is not an object'] };
  }

  if (!VALID_DECISIONS.has(obj.decision)) {
    errors.push(`decision must be one of ${[...VALID_DECISIONS].join(', ')}, got ${JSON.stringify(obj.decision)}`);
  }

  if (typeof obj.summary !== 'string' || obj.summary.length === 0) {
    errors.push('summary is required');
  } else if (obj.summary.length > 600) {
    errors.push(`summary must be at most 600 characters, got ${obj.summary.length}`);
  }

  const findings = Array.isArray(obj.findings) ? obj.findings : null;
  if (!findings) {
    errors.push('findings must be an array');
  } else {
    findings.forEach((f, i) => {
      if (!f || typeof f !== 'object') {
        errors.push(`findings[${i}] is not an object`);
        return;
      }
      if (!VALID_SEVERITIES.has(f.severity)) {
        errors.push(`findings[${i}].severity must be one of ${[...VALID_SEVERITIES].join(', ')}`);
      }
      if (!f.file) errors.push(`findings[${i}] is missing file`);
      if (!f.claim) errors.push(`findings[${i}] is missing claim`);
      if (MAJOR_OR_BLOCKER.has(f.severity) && !f.evidence) {
        errors.push(`findings[${i}] has severity ${f.severity} and requires evidence`);
      }
    });

    if (VALID_DECISIONS.has(obj.decision) && (obj.decision === 'reject' || obj.decision === 'changes_requested')) {
      if (!findings.some((f) => MAJOR_OR_BLOCKER.has(f?.severity))) {
        errors.push(`decision ${obj.decision} requires at least one blocker or major finding`);
      }
    }
    if (obj.decision === 'approve' && findings.some((f) => MAJOR_OR_BLOCKER.has(f?.severity))) {
      errors.push('decision approve allows only minor and nit findings');
    }
  }

  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
    errors.push(`confidence must be a number between 0 and 1, got ${JSON.stringify(obj.confidence)}`);
  }

  if (testsTouchedExpected) {
    if (obj.tests_touched !== true) {
      errors.push('post-run guard recorded touched test files: tests_touched must be true');
    }
    if (typeof obj.tests_touched_justified !== 'boolean') {
      errors.push('tests_touched_justified must be a boolean when tests were touched');
    }
    if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) {
      errors.push('summary must give a reason when tests were touched');
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// detectBlindnessBreach
// ---------------------------------------------------------------------------

/**
 * True when the reviewer's events.jsonl shows any line mentioning a path
 * under builder/ (either slash style) or a file named reasoning.md. Textual,
 * not JSON-parsed, per the wave card's exact wording; missing file -> no
 * detectable breach (false), not an error.
 */
export function detectBlindnessBreach(reviewerEventsPath) {
  let text;
  try {
    text = readFileSync(reviewerEventsPath, 'utf8');
  } catch {
    return false;
  }
  return text
    .split('\n')
    .some((line) => line.includes('builder/') || line.includes('builder\\') || line.includes('reasoning.md'));
}

// ---------------------------------------------------------------------------
// storeVerdict
// ---------------------------------------------------------------------------

// escalate() from src/limits.mjs owns halt -> input_required (and leaves a
// terminal task's status alone); use it here rather than the equivalent
// insertEscalation + setTaskStatus pair (unified per the wave's cross-module
// seams).
function haltAndEscalate(db, { taskId, runId, reason, detail }) {
  escalate(db, { taskId, runId: runId ?? null, reason, severity: 'halt', detail });
}

/**
 * Validates and stores a verdict per docs/state-machine.md's "Blind review
 * gate" and docs/review-protocol.md's "Challenge cycle" and "Verdict schema"
 * sections. Returns { code, verdictId, errors }.
 *
 * Review round 1, F1: the challenge_seq 0 uniqueness check and the
 * challenge-cycle count check are each a check-then-insert sequence, so each
 * is re-checked and the row inserted inside one `BEGIN IMMEDIATE`
 * transaction (src/db.mjs's withImmediateTransaction) - two concurrent
 * `verdict` calls for the same reviewer can no longer both observe "no blind
 * verdict yet" and both insert one, or both observe "one challenge cycle
 * used" and both insert a second. Everything that does not need the lock -
 * schema validation, reading reviewerEventsPath off disk for the blindness
 * check - runs first, same pattern as doRunStart in
 * src/commands/runs.mjs.
 */
export function storeVerdict(db, config, { taskId, runId, reviewer, provider, model, verdictObj, challenge, reviewerEventsPath }) {
  const task = getTask(db, taskId);
  if (!task) return { code: 1, verdictId: null, errors: [`no such task: ${taskId}`] };

  const testsTouchedExpected = listEscalations(db, taskId).some((e) => e.reason === 'test_edit');
  const { ok, errors } = validateVerdict(verdictObj, { testsTouchedExpected });
  if (!ok) {
    return { code: 5, verdictId: null, errors };
  }

  // Blindness detection reads reviewerEventsPath off disk - do it before
  // opening the transaction, same reasoning as F1's preflight-before-
  // BEGIN-IMMEDIATE pattern in doRunStart.
  const blind = reviewerEventsPath && detectBlindnessBreach(reviewerEventsPath) ? 0 : 1;

  const outcome = withImmediateTransaction(db, () => {
    let challengeSeq = 0;

    if (!challenge) {
      const existing = countVerdicts(db, taskId, { challengeSeq: 0, reviewer });
      if (existing > 0) {
        return {
          ok: false,
          reason: 'duplicate_blind',
          detail: `reviewer ${reviewer} already has a blind (challenge_seq 0) verdict on this task`,
        };
      }
    } else {
      const blindExists = countVerdicts(db, taskId, { challengeSeq: 0, reviewer });
      const hasArchitectChallenge = db
        .prepare(
          "SELECT COUNT(*) AS c FROM agent_messages WHERE task_id = ? AND kind = 'challenge' AND sender = 'architect' AND recipient = ?"
        )
        .get(taskId, reviewer).c;
      const challengeCount = db
        .prepare('SELECT COUNT(*) AS c FROM review_verdicts WHERE task_id = ? AND challenge_seq > 0')
        .get(taskId).c;

      if (blindExists === 0 || hasArchitectChallenge === 0 || challengeCount >= config.limits.challenge_cycles_max) {
        const detail = `challenge refused for reviewer ${reviewer}: blind_verdict_exists=${blindExists > 0} architect_challenge_sent=${hasArchitectChallenge > 0} challenge_count=${challengeCount} max=${config.limits.challenge_cycles_max}`;
        return { ok: false, reason: 'challenge_limit', detail };
      }

      const maxSeq = db
        .prepare('SELECT MAX(challenge_seq) AS m FROM review_verdicts WHERE task_id = ? AND reviewer = ?')
        .get(taskId, reviewer).m;
      challengeSeq = (maxSeq ?? 0) + 1;
    }

    const row = insertVerdict(db, {
      task_id: taskId,
      run_id: runId ?? null,
      reviewer,
      provider,
      model,
      blind,
      decision: verdictObj.decision,
      findings_total: Array.isArray(verdictObj.findings) ? verdictObj.findings.length : 0,
      findings_json: JSON.stringify(verdictObj),
      challenge_seq: challengeSeq,
      tests_touched: verdictObj.tests_touched ? 1 : 0,
      scope_exceeded: verdictObj.scope_exceeded ? 1 : 0,
      // arm defaults to the task's current arm inside insertVerdict.
    });
    return { ok: true, row };
  });

  if (!outcome.ok) {
    if (outcome.reason === 'duplicate_blind') {
      return { code: 6, verdictId: null, errors: [outcome.detail] };
    }
    haltAndEscalate(db, { taskId, runId, reason: 'challenge_limit', detail: outcome.detail });
    return { code: 3, verdictId: null, errors: [outcome.detail] };
  }

  if (blind === 0) {
    escalate(db, {
      taskId,
      runId: runId ?? null,
      reason: 'verdict_invalid',
      severity: 'warn',
      detail: `reviewer ${reviewer} events show a read under builder/ or reasoning.md`,
    });
  }

  return { code: 0, verdictId: outcome.row.id, errors: [] };
}

// ---------------------------------------------------------------------------
// adjudicate
// ---------------------------------------------------------------------------

/**
 * A human, not a model, decides which findings were real
 * (docs/review-protocol.md "Adjudication"). Works with or without a verdict
 * on the task, because the control arm has none - "unadjudicated" there is
 * instead defined by the absence of this human_interventions row.
 */
export function adjudicate(db, { taskId, real, noise, escaped, minutes, note, lesson, appliesTo }) {
  const verdicts = listVerdicts(db, taskId);
  const latest = verdicts.length ? verdicts[verdicts.length - 1] : null;

  if (latest) {
    db.prepare('UPDATE review_verdicts SET findings_real = ?, findings_noise = ? WHERE id = ?').run(
      real ?? null,
      noise ?? null,
      latest.id
    );
  }

  if (escaped !== undefined && escaped !== null) {
    db.prepare('UPDATE tasks SET defects_escaped = ? WHERE id = ?').run(escaped, taskId);
  }

  const intervention = insertIntervention(db, {
    task_id: taskId,
    kind: 'adjudicate',
    minutes: minutes ?? null,
    detail: note ?? null,
  });

  let lessonRow = null;
  if (lesson) {
    const task = getTask(db, taskId);
    lessonRow = addLesson(db, {
      source: 'adjudication',
      taskId,
      taskClass: task ? task.task_class : null,
      appliesTo: appliesTo ?? 'all',
      lesson,
      evidence: `adjudicate task=${taskId} real=${real ?? '-'} noise=${noise ?? '-'}`,
      confidence: 0.5,
    });
  }

  return { verdictId: latest ? latest.id : null, intervention, lesson: lessonRow };
}

// ---------------------------------------------------------------------------
// triageNote
// ---------------------------------------------------------------------------

function findingKey(f) {
  return `${f.file ?? ''}::${f.line ?? ''}::${(f.claim ?? '').slice(0, 60)}`;
}

function findingsOf(verdictRow) {
  try {
    const parsed = JSON.parse(verdictRow.findings_json ?? '{}');
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    return [];
  }
}

/** Markdown PR triage comment (docs/review-protocol.md "PR triage mode"). */
export function triageNote(db, config, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const verdicts = listVerdicts(db, taskId);
  // Latest verdict per reviewer (a reviewer may have a challenge_seq 1 follow-up).
  const latestByReviewer = new Map();
  for (const v of verdicts) latestByReviewer.set(v.reviewer, v);
  const reviewers = [...latestByReviewer.keys()];

  const lines = [];
  lines.push(`## Triage: ${task.title}`);
  lines.push(`task ${task.id}${task.pr_number ? `  PR #${task.pr_number}` : ''}  repo ${task.repo}`);
  lines.push('');

  if (reviewers.length === 0) {
    lines.push('No verdicts recorded yet.');
    return lines.join('\n');
  }

  if (reviewers.length === 1) {
    const v = latestByReviewer.get(reviewers[0]);
    lines.push(`### Findings (${v.reviewer})`);
    for (const f of findingsOf(v)) {
      lines.push(`- [${f.severity}] ${f.file ?? '-'}${f.line ? `:${f.line}` : ''} - ${f.claim ?? '-'} (${v.id})`);
    }
    return lines.join('\n');
  }

  const [rA, rB] = reviewers;
  const vA = latestByReviewer.get(rA);
  const vB = latestByReviewer.get(rB);
  const findingsA = findingsOf(vA);
  const findingsB = findingsOf(vB);
  const keysB = new Set(findingsB.map(findingKey));
  const keysA = new Set(findingsA.map(findingKey));

  const agreed = findingsA.filter((f) => keysB.has(findingKey(f)));
  const onlyA = findingsA.filter((f) => !keysB.has(findingKey(f)));
  const onlyB = findingsB.filter((f) => !keysA.has(findingKey(f)));

  lines.push('### Agreed findings');
  if (!agreed.length) lines.push('(none)');
  for (const f of agreed) lines.push(`- [${f.severity}] ${f.file ?? '-'}${f.line ? `:${f.line}` : ''} - ${f.claim ?? '-'}`);

  lines.push('');
  lines.push('### Disagreements');
  if (!onlyA.length && !onlyB.length) lines.push('(none)');
  for (const f of onlyA) lines.push(`- only ${rA}: [${f.severity}] ${f.file ?? '-'} - ${f.claim ?? '-'}`);
  for (const f of onlyB) lines.push(`- only ${rB}: [${f.severity}] ${f.file ?? '-'} - ${f.claim ?? '-'}`);

  lines.push('');
  lines.push('### Ledger ids');
  lines.push(`- task: ${task.id}`);
  for (const r of reviewers) lines.push(`- verdict (${r}): ${latestByReviewer.get(r).id}`);

  return lines.join('\n');
}
