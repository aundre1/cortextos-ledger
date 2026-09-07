// Retro (docs/autonomy.md "Retro"): reads the ledger for patterns, drafts
// lessons and proposals with status 'proposed'/'active' and author/source
// 'retro', and writes retro.md/retro.json. Never changes config, prompts, or
// routing - policy:apply is a separate, human-gated step.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getTask } from './ledger.mjs';
import { loadGoals, fillMetrics } from './goals.mjs';
import { add as addLesson, list as listLessons } from './lessons.mjs';
import { propose, listProposals } from './proposals.mjs';

const GUARD_FIRING_THRESHOLD = 3;
const REVIEWER_PRECISION_MIN_VERDICTS = 10;
const REVIEWER_PRECISION_MAX = 0.4;
const ARM_PAIRS_MIN = 20;
const ARM_COST_RATIO_MAX = 0.6;
const TOOL_FAILURE_THRESHOLD = 3;
const EPOCH = '0000-01-01T00:00:00.000Z';
const OPEN_PROPOSAL_STATUSES = ['proposed', 'under_review', 'approved'];

const GUARD_ACTOR = {
  files_touched: 'architect',
  test_edit: 'reviewer',
  tool_failure: 'builder',
  quota: 'architect',
  retry_limit: 'architect',
  budget: 'architect',
  wallclock: 'builder',
  challenge_limit: 'architect',
  dirty_worktree: 'builder',
  secrets: 'builder',
  stall: 'builder',
  verdict_invalid: 'reviewer',
  manual: 'all',
};

function mean(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** True once a proposal with this exact (kind, title) is already open (docs: "without duplicating an identical open one"). */
function hasOpenProposal(db, businessId, kind, title) {
  return listProposals(db, { business: businessId, kind }).some(
    (p) => p.title === title && OPEN_PROPOSAL_STATUSES.includes(p.status)
  );
}

/** True once an active retro-sourced lesson with this exact text and task_class already exists. */
function hasActiveLesson(db, taskClass, lessonText) {
  return listLessons(db, { taskClass, status: 'active' }).some((l) => l.source === 'retro' && l.lesson === lessonText);
}

function draftLesson(db, drafts, { taskClass, appliesTo, lesson, evidence }) {
  if (hasActiveLesson(db, taskClass, lesson)) return null;
  const row = addLesson(db, { source: 'retro', taskClass, appliesTo, lesson, evidence, confidence: 0.5 });
  drafts.lessons.push(row.id);
  return row;
}

function draftProposal(db, config, drafts, { businessId, kind, title, rationale, expectedImpact, taskClass, metric }) {
  if (hasOpenProposal(db, businessId, kind, title)) return null;
  const row = propose(db, config, {
    author: 'retro',
    business: businessId,
    kind,
    title,
    rationale,
    expectedImpact,
    taskClass,
    metric,
  });
  drafts.proposals.push(row.id);
  return row;
}

function isAdjudicated(db, task) {
  if (task.arm === 'control') {
    return (
      db.prepare("SELECT COUNT(*) AS c FROM human_interventions WHERE task_id = ? AND kind = 'adjudicate'").get(task.id).c > 0
    );
  }
  const v = db
    .prepare('SELECT findings_real FROM review_verdicts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(task.id);
  return !!v && v.findings_real != null;
}

// ---------------------------------------------------------------------------
// Pattern 1: a guard fired on the same task class repeatedly
// ---------------------------------------------------------------------------

function patternGuardFirings(db, sinceVal, drafts, findings) {
  const rows = db
    .prepare(
      `SELECT t.task_class AS task_class, e.reason AS reason, COUNT(*) AS c
       FROM escalations e JOIN tasks t ON t.id = e.task_id
       WHERE e.created_at >= ?
       GROUP BY t.task_class, e.reason
       HAVING COUNT(*) >= ?`
    )
    .all(sinceVal, GUARD_FIRING_THRESHOLD);

  for (const row of rows) {
    const actor = GUARD_ACTOR[row.reason] ?? 'architect';
    const lesson = `Guard ${row.reason} fired ${row.c} times on task_class ${row.task_class} in this window; the ${actor} should account for it before the run starts (for example, list every file expected to change in the brief when the guard is files_touched).`;
    findings.push({ pattern: 'guard_firings', task_class: row.task_class, reason: row.reason, count: row.c });
    draftLesson(db, drafts, {
      taskClass: row.task_class,
      appliesTo: actor,
      lesson,
      evidence: `escalations: ${row.c} ${row.reason} on ${row.task_class} since ${sinceVal}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Pattern 2: low reviewer precision for a provider on a class
// ---------------------------------------------------------------------------

function patternReviewerPrecision(db, config, sinceVal, businessId, drafts, findings) {
  const rows = db
    .prepare(
      `SELECT v.provider AS provider, t.task_class AS task_class,
              SUM(v.findings_real) AS real, SUM(v.findings_total) AS total, COUNT(*) AS n
       FROM review_verdicts v JOIN tasks t ON t.id = v.task_id
       WHERE v.findings_real IS NOT NULL AND v.created_at >= ?
       GROUP BY v.provider, t.task_class
       HAVING COUNT(*) >= ?`
    )
    .all(sinceVal, REVIEWER_PRECISION_MIN_VERDICTS);

  for (const row of rows) {
    if (!row.total) continue;
    const precision = row.real / row.total;
    if (precision >= REVIEWER_PRECISION_MAX) continue;
    findings.push({ pattern: 'reviewer_precision', provider: row.provider, task_class: row.task_class, precision, n: row.n });
    draftProposal(db, config, drafts, {
      businessId,
      kind: 'policy',
      title: `Drop or swap reviewer ${row.provider} for task_class ${row.task_class}`,
      rationale: `Reviewer precision for ${row.provider} on ${row.task_class} is ${precision.toFixed(2)} over ${row.n} adjudicated verdicts, under the ${REVIEWER_PRECISION_MAX} floor.`,
      expectedImpact: `raise reviewer precision on ${row.task_class}`,
      taskClass: row.task_class,
    });
  }
}

// ---------------------------------------------------------------------------
// Patterns 3 and 4: control versus tri, by task class
// ---------------------------------------------------------------------------

function patternArmComparison(db, config, sinceVal, businessId, drafts, findings) {
  const triTasks = db
    .prepare("SELECT * FROM tasks WHERE arm = 'tri' AND sibling_id IS NOT NULL AND created_at >= ?")
    .all(sinceVal);

  const byClass = new Map();
  for (const tri of triTasks) {
    const control = getTask(db, tri.sibling_id);
    if (!control || control.arm !== 'control') continue;
    if (!isAdjudicated(db, tri) || !isAdjudicated(db, control)) continue;
    const costTri = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS t FROM cost_usage WHERE task_id = ?').get(tri.id).t;
    const costControl = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS t FROM cost_usage WHERE task_id = ?').get(control.id).t;
    const list = byClass.get(tri.task_class) ?? [];
    list.push({
      defectsTri: tri.defects_escaped ?? 0,
      defectsControl: control.defects_escaped ?? 0,
      costTri,
      costControl,
    });
    byClass.set(tri.task_class, list);
  }

  for (const [taskClass, pairs] of byClass) {
    if (pairs.length < ARM_PAIRS_MIN) continue;
    const meanDefectsTri = mean(pairs.map((p) => p.defectsTri));
    const meanDefectsControl = mean(pairs.map((p) => p.defectsControl));
    const meanCostTri = mean(pairs.map((p) => p.costTri));
    const meanCostControl = mean(pairs.map((p) => p.costControl));

    if (meanDefectsTri === meanDefectsControl && meanCostTri > 0 && meanCostControl / meanCostTri < ARM_COST_RATIO_MAX) {
      findings.push({ pattern: 'control_matches_tri_cheaper', task_class: taskClass, pairs: pairs.length });
      draftProposal(db, config, drafts, {
        businessId,
        kind: 'policy',
        title: `Route task_class ${taskClass} to a single agent (control)`,
        rationale: `${pairs.length} adjudicated pairs: control matches tri on escaped defects (${meanDefectsControl}) at ${(meanCostControl / meanCostTri).toFixed(2)}x the cost.`,
        expectedImpact: `cut cost on ${taskClass} without losing quality`,
        taskClass,
      });
    } else if (meanDefectsTri < meanDefectsControl) {
      const multiple = meanCostControl > 0 ? meanCostTri / meanCostControl : null;
      findings.push({ pattern: 'tri_catches_more', task_class: taskClass, pairs: pairs.length, cost_multiple: multiple });
      draftProposal(db, config, drafts, {
        businessId,
        kind: 'policy',
        title: `Keep tri for task_class ${taskClass}`,
        rationale: `${pairs.length} adjudicated pairs: tri ships fewer escaped defects (${meanDefectsTri} vs ${meanDefectsControl}) at ${multiple != null ? multiple.toFixed(2) : '?'}x the control cost.`,
        expectedImpact: `avoid escaped defects on ${taskClass}`,
        taskClass,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pattern 5: a goal metric has a gap with no open task or proposal
// ---------------------------------------------------------------------------

function patternGoalGaps(db, config, businessFilter, drafts, findings) {
  const filled = fillMetrics(db, config, loadGoals(config));
  const businesses = businessFilter ? filled.businesses.filter((b) => b.id === businessFilter) : filled.businesses;
  for (const biz of businesses) {
    for (const metric of biz.metrics ?? []) {
      if (metric.gap == null || metric.gap === 0) continue;
      const alreadyTargeted = listProposals(db, { business: biz.id }).some(
        (p) => p.goal_metric === metric.name && OPEN_PROPOSAL_STATUSES.includes(p.status)
      );
      if (alreadyTargeted) continue;
      findings.push({ pattern: 'goal_gap', business: biz.id, metric: metric.name, gap: metric.gap });
      draftProposal(db, config, drafts, {
        businessId: biz.id,
        kind: 'task',
        title: `Close the gap on ${metric.name} for ${biz.id}`,
        rationale: `${metric.name} is at ${metric.current ?? 'unknown'} against a target of ${metric.target}, a gap of ${metric.gap}.`,
        expectedImpact: `move ${metric.name} toward its target`,
        taskClass: (biz.task_classes ?? [])[0],
        metric: metric.name,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Pattern 6: the same tool failure repeats across runs
// ---------------------------------------------------------------------------

function patternToolFailures(db, config, sinceVal, businessId, drafts, findings) {
  const rows = db.prepare("SELECT detail FROM escalations WHERE reason = 'tool_failure' AND created_at >= ?").all(sinceVal);
  const byTool = new Map();
  for (const r of rows) {
    const tool = (r.detail ?? '').split(':')[0].trim() || 'unknown tool';
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  for (const [tool, count] of byTool) {
    if (count < TOOL_FAILURE_THRESHOLD) continue;
    findings.push({ pattern: 'tool_failure', tool, count });
    draftProposal(db, config, drafts, {
      businessId,
      kind: 'tooling',
      title: `Fix or replace tool ${tool}`,
      rationale: `${tool} failed ${count} times across runs in this window.`,
      expectedImpact: 'stop tool failures from being improvised around',
    });
  }
}

// ---------------------------------------------------------------------------
// Pattern 7: a quota window hit its limit
// ---------------------------------------------------------------------------

function patternQuotaHits(db, config, businessId, drafts, findings) {
  const rows = db.prepare('SELECT * FROM provider_quota').all();
  for (const q of rows) {
    const hitRequests = q.limit_requests != null && q.used_requests >= q.limit_requests;
    const hitUsd = q.limit_usd != null && q.used_usd >= q.limit_usd;
    if (!hitRequests && !hitUsd) continue;
    findings.push({ pattern: 'quota_hit', provider: q.provider, model: q.model, window_kind: q.window_kind });
    draftProposal(db, config, drafts, {
      businessId,
      kind: 'tooling',
      title: `Add capacity or reroute for ${q.provider}${q.model ? ` ${q.model}` : ''} ${q.window_kind}`,
      rationale: `Quota window ${q.provider}${q.model ? ` ${q.model}` : ''} ${q.window_kind} is at its limit.`,
      expectedImpact: 'avoid stalling on quota exhaustion',
    });
  }
}

// ---------------------------------------------------------------------------
// retro
// ---------------------------------------------------------------------------

/**
 * Runs every pattern in docs/autonomy.md's table, writes retro.md/retro.json
 * to outDir, and returns { findings, drafts: { lessons: [...ids], proposals:
 * [...ids] }, files }. A second run over the same window drafts nothing new
 * (dedup on kind+title for proposals, source+task_class+text for lessons).
 */
export function retro(db, config, { since, business, outDir, now = new Date() } = {}) {
  const sinceVal = since ?? EPOCH;
  const businessIdForDrafts = business ?? 'ledger';
  const findings = [];
  const drafts = { lessons: [], proposals: [] };

  patternGuardFirings(db, sinceVal, drafts, findings);
  patternReviewerPrecision(db, config, sinceVal, businessIdForDrafts, drafts, findings);
  patternArmComparison(db, config, sinceVal, businessIdForDrafts, drafts, findings);
  patternGoalGaps(db, config, business, drafts, findings);
  patternToolFailures(db, config, sinceVal, businessIdForDrafts, drafts, findings);
  patternQuotaHits(db, config, businessIdForDrafts, drafts, findings);

  const result = {
    retro_version: '1',
    generated_at: now.toISOString(),
    since: since ?? null,
    business: business ?? null,
    findings,
    drafted_lessons: drafts.lessons,
    drafted_proposals: drafts.proposals,
  };

  const lines = [`# Retro${business ? ` (${business})` : ''}`, ''];
  if (!findings.length) lines.push('No patterns crossed a threshold in this window.');
  for (const f of findings) lines.push(`- ${f.pattern}: ${JSON.stringify(f)}`);
  lines.push('', `Drafted ${drafts.lessons.length} lesson(s), ${drafts.proposals.length} proposal(s).`);
  const markdown = lines.join('\n') + '\n';

  let files = [];
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const jsonPath = join(outDir, 'retro.json');
    const mdPath = join(outDir, 'retro.md');
    writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    writeFileSync(mdPath, markdown);
    files = [jsonPath, mdPath];
  }

  return { ...result, markdown, files };
}
