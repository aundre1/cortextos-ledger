// Typed insert/select helpers, one per table. Every function takes a `db`
// handle first; plain objects in, plain objects out (no ORM, no classes).
//
// Id prefixes (see the wave todo's "Fixed identifiers" line and
// docs/ledger.md): t_ tasks, r_ task_runs, m_ agent_messages, a_ artifacts,
// v_ review_verdicts, c_ cost_usage, e_ escalations, q_ provider_quota,
// h_ human_interventions, u_ usage_snapshots (Fable arbitration 2026-09-07:
// test_results keeps s_ - see the wave log OPEN QUESTION on the prefix
// table only having 10 letters for 11 tables - and usage_snapshots gets its
// own u_ prefix instead of colliding with it).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { newId, nowIso } from './db.mjs';
import { findQuotaRow } from './quota.mjs';

const nullish = (v) => (v === undefined ? null : v);

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export function insertTask(db, fields) {
  const row = {
    // `fields.id` lets a caller precompute the id before insert (task E1-1's
    // task:new PR capture: the run dir / pr.diff path needs a task id before
    // insertTask runs, so the id, run-dir write, and the insert itself can
    // all key off the same value, with insertTask/insertMessage/insertArtifact
    // wrapped in one withImmediateTransaction). Every other caller omits it
    // and gets the usual freshly generated id.
    id: fields.id ?? newId('t'),
    created_at: nowIso(),
    repo: fields.repo,
    issue_number: nullish(fields.issue_number),
    pr_number: nullish(fields.pr_number),
    // PR capture (task E1-1, src/schema/005-v02-pr-capture.mjs): the repo a
    // pr_review task's pull request lives in, and the two commit shas
    // `gh pr view` reports (baseRefOid/headRefOid) at capture time.
    pr_repo: nullish(fields.pr_repo),
    base_sha: nullish(fields.base_sha),
    head_sha: nullish(fields.head_sha),
    kind: fields.kind ?? 'implement',
    title: fields.title,
    task_class: fields.task_class,
    arm: fields.arm,
    owner: nullish(fields.owner),
    priority: fields.priority ?? 3,
    due_at: nullish(fields.due_at),
    parent_id: nullish(fields.parent_id),
    sibling_id: nullish(fields.sibling_id),
    base_commit: nullish(fields.base_commit),
    branch: nullish(fields.branch),
    worktree: nullish(fields.worktree),
    pr_url: nullish(fields.pr_url),
    status: fields.status ?? 'submitted',
    outcome: nullish(fields.outcome),
    human_edits: fields.human_edits ?? 0,
    defects_escaped: fields.defects_escaped ?? 0,
    closed_at: nullish(fields.closed_at),
    notes: nullish(fields.notes),
  };
  db.prepare(
    `INSERT INTO tasks
       (id, created_at, repo, issue_number, pr_number, pr_repo, base_sha, head_sha, kind, title,
        task_class, arm, owner, priority, due_at, parent_id, sibling_id, base_commit, branch,
        worktree, pr_url, status, outcome, human_edits, defects_escaped, closed_at, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.created_at, row.repo, row.issue_number, row.pr_number, row.pr_repo, row.base_sha,
    row.head_sha, row.kind, row.title, row.task_class, row.arm, row.owner, row.priority, row.due_at,
    row.parent_id, row.sibling_id, row.base_commit, row.branch, row.worktree, row.pr_url, row.status,
    row.outcome, row.human_edits, row.defects_escaped, row.closed_at, row.notes
  );
  return row;
}

export function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
}

/** listTasks({ status, owner }): both filters optional. */
export function listTasks(db, { status, owner } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (owner) {
    clauses.push('owner = ?');
    params.push(owner);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at`).all(...params);
}

export function setTaskStatus(db, taskId, status) {
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
  return getTask(db, taskId);
}

// ---------------------------------------------------------------------------
// task_runs
// ---------------------------------------------------------------------------

export function insertRun(db, fields) {
  const row = {
    id: newId('r'),
    task_id: fields.task_id,
    seq: fields.seq,
    agent: fields.agent,
    provider: fields.provider,
    model: fields.model,
    started_at: fields.started_at ?? nowIso(),
    ended_at: nullish(fields.ended_at),
    status: fields.status ?? 'running',
    tokens_in: fields.tokens_in ?? 0,
    tokens_out: fields.tokens_out ?? 0,
    cost_usd: fields.cost_usd ?? 0,
    tool_calls: fields.tool_calls ?? 0,
    session_id: nullish(fields.session_id),
    summary: nullish(fields.summary),
    worktree: nullish(fields.worktree),
    out_dir: nullish(fields.out_dir),
    exit_code: nullish(fields.exit_code),
    files_touched: nullish(fields.files_touched),
    wallclock_limit_s: nullish(fields.wallclock_limit_s),
    halted_reason: nullish(fields.halted_reason),
    pid: nullish(fields.pid),
    // Review round 1, F4: recorded so run:start can enforce
    // `opencode_serial` (refuse a second concurrent opencode run) without
    // guessing an adapter from `agent`/`provider` - see
    // src/schema/004-v02-run-adapter.mjs.
    adapter: nullish(fields.adapter),
  };
  db.prepare(
    `INSERT INTO task_runs
       (id, task_id, seq, agent, provider, model, started_at, ended_at, status,
        tokens_in, tokens_out, cost_usd, tool_calls, session_id, summary,
        worktree, out_dir, exit_code, files_touched, wallclock_limit_s, halted_reason, pid, adapter)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.seq, row.agent, row.provider, row.model, row.started_at,
    row.ended_at, row.status, row.tokens_in, row.tokens_out, row.cost_usd, row.tool_calls,
    row.session_id, row.summary, row.worktree, row.out_dir, row.exit_code, row.files_touched,
    row.wallclock_limit_s, row.halted_reason, row.pid, row.adapter
  );
  return row;
}

export function listRuns(db, taskId) {
  return db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY seq').all(taskId);
}

/**
 * Next seq value for a new run on `taskId`: MAX(seq)+1, not COUNT+1 (review
 * round 1, F1) - under `withImmediateTransaction` this is read and the row
 * it feeds `insertRun` inserted atomically, so two concurrent run:start
 * calls can never compute the same seq.
 */
export function nextRunSeq(db, taskId) {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM task_runs WHERE task_id = ?').get(taskId);
  return row.m + 1;
}

/** Number of runs for a task, optionally restricted to a set of agents. */
export function countRuns(db, taskId, agents = []) {
  if (!agents.length) {
    return db.prepare('SELECT COUNT(*) AS c FROM task_runs WHERE task_id = ?').get(taskId).c;
  }
  const placeholders = agents.map(() => '?').join(',');
  return db
    .prepare(`SELECT COUNT(*) AS c FROM task_runs WHERE task_id = ? AND agent IN (${placeholders})`)
    .get(taskId, ...agents).c;
}

// ---------------------------------------------------------------------------
// agent_messages
// ---------------------------------------------------------------------------

export function insertMessage(db, fields) {
  const row = {
    id: newId('m'),
    task_id: fields.task_id,
    run_id: nullish(fields.run_id),
    created_at: nowIso(),
    sender: fields.sender,
    recipient: fields.recipient,
    kind: fields.kind,
    body: fields.body ?? '',
  };
  db.prepare(
    `INSERT INTO agent_messages (id, task_id, run_id, created_at, sender, recipient, kind, body)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(row.id, row.task_id, row.run_id, row.created_at, row.sender, row.recipient, row.kind, row.body);
  return row;
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

/** Insert an artifact; sha256 and bytes are computed when path exists on disk. */
export function insertArtifact(db, fields) {
  let sha256 = null;
  let bytes = null;
  if (fields.path && existsSync(fields.path)) {
    const buf = readFileSync(fields.path);
    sha256 = createHash('sha256').update(buf).digest('hex');
    bytes = statSync(fields.path).size;
  }
  const row = {
    id: newId('a'),
    task_id: fields.task_id,
    run_id: nullish(fields.run_id),
    created_at: nowIso(),
    kind: fields.kind,
    path: nullish(fields.path),
    sha256,
    bytes,
  };
  db.prepare(
    `INSERT INTO artifacts (id, task_id, run_id, created_at, kind, path, sha256, bytes)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(row.id, row.task_id, row.run_id, row.created_at, row.kind, row.path, row.sha256, row.bytes);
  return row;
}

// ---------------------------------------------------------------------------
// review_verdicts
// ---------------------------------------------------------------------------

export function insertVerdict(db, fields) {
  // arm is copied from the task at insert time (docs/ledger.md) so callers
  // do not each need to look it up and verdict statistics need no join.
  let arm = fields.arm;
  if (arm === undefined) {
    const task = getTask(db, fields.task_id);
    arm = task ? task.arm : null;
  }
  const row = {
    id: newId('v'),
    task_id: fields.task_id,
    run_id: nullish(fields.run_id),
    created_at: nowIso(),
    reviewer: fields.reviewer,
    provider: fields.provider,
    model: fields.model,
    blind: fields.blind === 0 ? 0 : fields.blind === false ? 0 : 1,
    decision: fields.decision,
    findings_total: fields.findings_total ?? 0,
    findings_real: nullish(fields.findings_real),
    findings_noise: nullish(fields.findings_noise),
    findings_json: nullish(fields.findings_json),
    arm: nullish(arm),
    challenge_seq: fields.challenge_seq ?? 0,
    tests_touched: nullish(fields.tests_touched),
    scope_exceeded: nullish(fields.scope_exceeded),
  };
  db.prepare(
    `INSERT INTO review_verdicts
       (id, task_id, run_id, created_at, reviewer, provider, model, blind, decision,
        findings_total, findings_real, findings_noise, findings_json, arm, challenge_seq,
        tests_touched, scope_exceeded)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.run_id, row.created_at, row.reviewer, row.provider, row.model,
    row.blind, row.decision, row.findings_total, row.findings_real, row.findings_noise,
    row.findings_json, row.arm, row.challenge_seq, row.tests_touched, row.scope_exceeded
  );
  return row;
}

export function listVerdicts(db, taskId) {
  return db.prepare('SELECT * FROM review_verdicts WHERE task_id = ? ORDER BY created_at').all(taskId);
}

/** countVerdicts(taskId, { challengeSeq, reviewer }): both filters optional. */
export function countVerdicts(db, taskId, { challengeSeq, reviewer } = {}) {
  const clauses = ['task_id = ?'];
  const params = [taskId];
  if (challengeSeq !== undefined) {
    clauses.push('challenge_seq = ?');
    params.push(challengeSeq);
  }
  if (reviewer !== undefined) {
    clauses.push('reviewer = ?');
    params.push(reviewer);
  }
  return db
    .prepare(`SELECT COUNT(*) AS c FROM review_verdicts WHERE ${clauses.join(' AND ')}`)
    .get(...params).c;
}

// ---------------------------------------------------------------------------
// test_results
// ---------------------------------------------------------------------------

export function insertTest(db, fields) {
  const row = {
    id: newId('s'),
    task_id: fields.task_id,
    run_id: nullish(fields.run_id),
    created_at: nowIso(),
    suite: fields.suite,
    command: nullish(fields.command),
    status: fields.status,
    passed: fields.passed ?? 0,
    failed: fields.failed ?? 0,
    duration_ms: nullish(fields.duration_ms),
    log_path: nullish(fields.log_path),
  };
  db.prepare(
    `INSERT INTO test_results
       (id, task_id, run_id, created_at, suite, command, status, passed, failed, duration_ms, log_path)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.run_id, row.created_at, row.suite, row.command, row.status,
    row.passed, row.failed, row.duration_ms, row.log_path
  );
  return row;
}

export function listTests(db, taskId) {
  return db.prepare('SELECT * FROM test_results WHERE task_id = ? ORDER BY created_at').all(taskId);
}

// ---------------------------------------------------------------------------
// cost_usage
// ---------------------------------------------------------------------------

export function insertCost(db, fields) {
  const row = {
    id: newId('c'),
    task_id: fields.task_id,
    run_id: nullish(fields.run_id),
    created_at: nowIso(),
    provider: fields.provider,
    model: fields.model,
    tokens_in: fields.tokens_in ?? 0,
    tokens_out: fields.tokens_out ?? 0,
    cost_usd: fields.cost_usd ?? 0,
    requests: fields.requests ?? 0,
    source: nullish(fields.source),
  };
  db.prepare(
    `INSERT INTO cost_usage
       (id, task_id, run_id, created_at, provider, model, tokens_in, tokens_out, cost_usd, requests, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.run_id, row.created_at, row.provider, row.model, row.tokens_in,
    row.tokens_out, row.cost_usd, row.requests, row.source
  );
  return row;
}

export function sumCost(db, taskId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_usage WHERE task_id = ?')
    .get(taskId);
  return row.total;
}

// ---------------------------------------------------------------------------
// escalations
// ---------------------------------------------------------------------------

export function insertEscalation(db, fields) {
  const row = {
    id: newId('e'),
    task_id: fields.task_id,
    created_at: nowIso(),
    reason: fields.reason,
    detail: nullish(fields.detail),
    resolved_at: nullish(fields.resolved_at),
    resolution: nullish(fields.resolution),
    run_id: nullish(fields.run_id),
    severity: nullish(fields.severity),
  };
  db.prepare(
    `INSERT INTO escalations
       (id, task_id, created_at, reason, detail, resolved_at, resolution, run_id, severity)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.task_id, row.created_at, row.reason, row.detail, row.resolved_at,
    row.resolution, row.run_id, row.severity
  );
  return row;
}

export function listEscalations(db, taskId) {
  return db.prepare('SELECT * FROM escalations WHERE task_id = ? ORDER BY created_at').all(taskId);
}

// ---------------------------------------------------------------------------
// human_interventions
// ---------------------------------------------------------------------------

export function insertIntervention(db, fields) {
  const row = {
    id: newId('h'),
    task_id: fields.task_id,
    run_id: nullish(fields.run_id),
    created_at: nowIso(),
    kind: fields.kind,
    minutes: nullish(fields.minutes),
    detail: nullish(fields.detail),
  };
  db.prepare(
    `INSERT INTO human_interventions (id, task_id, run_id, created_at, kind, minutes, detail)
     VALUES (?,?,?,?,?,?,?)`
  ).run(row.id, row.task_id, row.run_id, row.created_at, row.kind, row.minutes, row.detail);
  return row;
}

// ---------------------------------------------------------------------------
// usage_snapshots
// ---------------------------------------------------------------------------

export function insertSnapshot(db, fields) {
  const row = {
    id: newId('u'),
    created_at: nowIso(),
    provider: fields.provider,
    plan: nullish(fields.plan),
    window_kind: nullish(fields.window_kind),
    used_pct: nullish(fields.used_pct),
    resets_at: nullish(fields.resets_at),
    task_id: nullish(fields.task_id),
    phase: nullish(fields.phase),
    source: fields.source ?? 'manual',
  };
  db.prepare(
    `INSERT INTO usage_snapshots
       (id, created_at, provider, plan, window_kind, used_pct, resets_at, task_id, phase, source)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.created_at, row.provider, row.plan, row.window_kind, row.used_pct,
    row.resets_at, row.task_id, row.phase, row.source
  );
  return row;
}

export function listSnapshots(db, { provider, taskId } = {}) {
  const clauses = [];
  const params = [];
  if (provider) {
    clauses.push('provider = ?');
    params.push(provider);
  }
  if (taskId) {
    clauses.push('task_id = ?');
    params.push(taskId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM usage_snapshots ${where} ORDER BY created_at`).all(...params);
}

// ---------------------------------------------------------------------------
// provider_quota
// ---------------------------------------------------------------------------

/**
 * Upsert a quota window's limits (cortexctl quota:set). Finds the existing
 * row by (provider, model, window_kind); updates its limits and source if
 * found, otherwise inserts a fresh window with zero usage starting now.
 * Never touches used_requests/used_usd on an existing row - only
 * quota:tick / ingest change usage (see src/quota.mjs).
 */
export function upsertQuota(db, fields) {
  const provider = fields.provider;
  const model = nullish(fields.model);
  const windowKind = fields.window_kind;
  const existing = findQuotaRow(db, { provider, model, windowKind });
  const now = nowIso();

  if (existing) {
    db.prepare(
      `UPDATE provider_quota
         SET limit_requests = ?, limit_usd = ?, source = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      fields.limit_requests !== undefined ? nullish(fields.limit_requests) : existing.limit_requests,
      fields.limit_usd !== undefined ? nullish(fields.limit_usd) : existing.limit_usd,
      fields.source ?? existing.source,
      now,
      existing.id
    );
    // Re-read rather than hand-merge fields over existing, so the returned
    // object always matches what was actually persisted (usage columns are
    // never touched here - only quota:tick / ingest change usage).
    return db.prepare('SELECT * FROM provider_quota WHERE id = ?').get(existing.id);
  }

  const row = {
    id: newId('q'),
    provider,
    model,
    window_kind: windowKind,
    window_started_at: fields.window_started_at ?? now,
    limit_requests: nullish(fields.limit_requests),
    limit_usd: nullish(fields.limit_usd),
    used_requests: fields.used_requests ?? 0,
    used_usd: fields.used_usd ?? 0,
    source: fields.source ?? 'config',
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO provider_quota
       (id, provider, model, window_kind, window_started_at, limit_requests, limit_usd,
        used_requests, used_usd, source, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.provider, row.model, row.window_kind, row.window_started_at, row.limit_requests,
    row.limit_usd, row.used_requests, row.used_usd, row.source, row.updated_at
  );
  return row;
}

export function listQuota(db, { provider } = {}) {
  if (provider) {
    return db
      .prepare('SELECT * FROM provider_quota WHERE provider = ? ORDER BY provider, model, window_kind')
      .all(provider);
  }
  return db.prepare('SELECT * FROM provider_quota ORDER BY provider, model, window_kind').all();
}

// ---------------------------------------------------------------------------
// autonomy layer (docs/autonomy.md): proposals, proposal_reviews, lessons,
// policy, loop_ticks. Same style as every table above: insert/list/get/
// update-status helpers, plain objects in and out.
// ---------------------------------------------------------------------------

// -- proposals ---------------------------------------------------------------

export function insertProposal(db, fields) {
  const row = {
    id: newId('p'),
    created_at: nowIso(),
    author: fields.author,
    business_id: fields.business_id,
    goal_metric: nullish(fields.goal_metric),
    kind: fields.kind,
    title: fields.title,
    rationale: nullish(fields.rationale),
    expected_impact: nullish(fields.expected_impact),
    estimated_usd: nullish(fields.estimated_usd),
    estimated_hours: nullish(fields.estimated_hours),
    task_class: nullish(fields.task_class),
    status: fields.status ?? 'proposed',
    converted_task_id: nullish(fields.converted_task_id),
    decided_by: nullish(fields.decided_by),
    decided_at: nullish(fields.decided_at),
    decision_note: nullish(fields.decision_note),
  };
  db.prepare(
    `INSERT INTO proposals
       (id, created_at, author, business_id, goal_metric, kind, title, rationale, expected_impact,
        estimated_usd, estimated_hours, task_class, status, converted_task_id, decided_by, decided_at, decision_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.created_at, row.author, row.business_id, row.goal_metric, row.kind, row.title,
    row.rationale, row.expected_impact, row.estimated_usd, row.estimated_hours, row.task_class,
    row.status, row.converted_task_id, row.decided_by, row.decided_at, row.decision_note
  );
  return row;
}

export function getProposal(db, id) {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) ?? null;
}

/** listProposals({ status, businessId, author, kind }): every filter optional. */
export function listProposals(db, { status, businessId, author, kind } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (businessId) {
    clauses.push('business_id = ?');
    params.push(businessId);
  }
  if (author) {
    clauses.push('author = ?');
    params.push(author);
  }
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM proposals ${where} ORDER BY created_at`).all(...params);
}

/** Update a proposal's status, plus any decision fields given (converted_task_id, decided_by, decided_at, decision_note). */
export function setProposalStatus(db, id, status, extra = {}) {
  const current = getProposal(db, id);
  if (!current) return null;
  const merged = {
    converted_task_id: extra.converted_task_id !== undefined ? extra.converted_task_id : current.converted_task_id,
    decided_by: extra.decided_by !== undefined ? extra.decided_by : current.decided_by,
    decided_at: extra.decided_at !== undefined ? extra.decided_at : current.decided_at,
    decision_note: extra.decision_note !== undefined ? extra.decision_note : current.decision_note,
  };
  db.prepare(
    'UPDATE proposals SET status = ?, converted_task_id = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?'
  ).run(status, merged.converted_task_id, merged.decided_by, merged.decided_at, merged.decision_note, id);
  return getProposal(db, id);
}

// -- proposal_reviews ---------------------------------------------------------

export function insertProposalReview(db, fields) {
  const row = {
    id: newId('pr'),
    proposal_id: fields.proposal_id,
    created_at: nowIso(),
    reviewer: fields.reviewer,
    verdict: fields.verdict,
    note: nullish(fields.note),
    confidence: nullish(fields.confidence),
  };
  db.prepare(
    `INSERT INTO proposal_reviews (id, proposal_id, created_at, reviewer, verdict, note, confidence)
     VALUES (?,?,?,?,?,?,?)`
  ).run(row.id, row.proposal_id, row.created_at, row.reviewer, row.verdict, row.note, row.confidence);
  return row;
}

/** listProposalReviews({ proposalId, reviewer }): both filters optional. */
export function listProposalReviews(db, { proposalId, reviewer } = {}) {
  const clauses = [];
  const params = [];
  if (proposalId) {
    clauses.push('proposal_id = ?');
    params.push(proposalId);
  }
  if (reviewer) {
    clauses.push('reviewer = ?');
    params.push(reviewer);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM proposal_reviews ${where} ORDER BY created_at`).all(...params);
}

// -- lessons -------------------------------------------------------------

export function insertLesson(db, fields) {
  const row = {
    id: newId('l'),
    created_at: nowIso(),
    source: fields.source,
    task_id: nullish(fields.task_id),
    business_id: nullish(fields.business_id),
    task_class: nullish(fields.task_class),
    applies_to: fields.applies_to ?? 'all',
    lesson: fields.lesson,
    evidence: nullish(fields.evidence),
    confidence: fields.confidence ?? 0.5,
    status: fields.status ?? 'active',
    retired_reason: nullish(fields.retired_reason),
  };
  db.prepare(
    `INSERT INTO lessons
       (id, created_at, source, task_id, business_id, task_class, applies_to, lesson, evidence,
        confidence, status, retired_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.created_at, row.source, row.task_id, row.business_id, row.task_class, row.applies_to,
    row.lesson, row.evidence, row.confidence, row.status, row.retired_reason
  );
  return row;
}

export function getLesson(db, id) {
  return db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) ?? null;
}

/** listLessons({ taskClass, appliesTo, status }): every filter optional. */
export function listLessons(db, { taskClass, appliesTo, status } = {}) {
  const clauses = [];
  const params = [];
  if (taskClass !== undefined) {
    clauses.push('task_class IS ?');
    params.push(taskClass);
  }
  if (appliesTo) {
    clauses.push('applies_to = ?');
    params.push(appliesTo);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM lessons ${where} ORDER BY created_at`).all(...params);
}

export function setLessonStatus(db, id, status, { retiredReason } = {}) {
  db.prepare('UPDATE lessons SET status = ?, retired_reason = COALESCE(?, retired_reason) WHERE id = ?').run(
    status,
    retiredReason ?? null,
    id
  );
  return getLesson(db, id);
}

// -- policy ----------------------------------------------------------------

export function insertPolicy(db, fields) {
  const row = {
    id: newId('po'),
    applied_at: fields.applied_at ?? nowIso(),
    proposal_id: nullish(fields.proposal_id),
    task_class: fields.task_class,
    agent_overrides_json: fields.agent_overrides_json,
    applied_by: fields.applied_by,
    active: fields.active === 0 || fields.active === false ? 0 : 1,
  };
  db.prepare(
    `INSERT INTO policy (id, applied_at, proposal_id, task_class, agent_overrides_json, applied_by, active)
     VALUES (?,?,?,?,?,?,?)`
  ).run(row.id, row.applied_at, row.proposal_id, row.task_class, row.agent_overrides_json, row.applied_by, row.active);
  return row;
}

export function getPolicy(db, id) {
  return db.prepare('SELECT * FROM policy WHERE id = ?').get(id) ?? null;
}

/** listPolicy({ taskClass, active }): both filters optional; active is 0/1. */
export function listPolicy(db, { taskClass, active } = {}) {
  const clauses = [];
  const params = [];
  if (taskClass) {
    clauses.push('task_class = ?');
    params.push(taskClass);
  }
  if (active !== undefined) {
    clauses.push('active = ?');
    params.push(active ? 1 : 0);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM policy ${where} ORDER BY applied_at DESC`).all(...params);
}

export function setPolicyActive(db, id, active) {
  db.prepare('UPDATE policy SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return getPolicy(db, id);
}

// -- loop_ticks --------------------------------------------------------------

export function insertLoopTick(db, fields) {
  const row = {
    id: newId('lt'),
    agent: fields.agent,
    started_at: fields.started_at ?? nowIso(),
    ended_at: fields.ended_at ?? nowIso(),
    action: fields.action,
    task_id: nullish(fields.task_id),
    proposal_id: nullish(fields.proposal_id),
    cost_usd: fields.cost_usd ?? 0,
    note: nullish(fields.note),
  };
  db.prepare(
    `INSERT INTO loop_ticks (id, agent, started_at, ended_at, action, task_id, proposal_id, cost_usd, note)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(row.id, row.agent, row.started_at, row.ended_at, row.action, row.task_id, row.proposal_id, row.cost_usd, row.note);
  return row;
}

/** listLoopTicks({ agent }): filter optional; newest first. */
export function listLoopTicks(db, { agent } = {}) {
  const clauses = [];
  const params = [];
  if (agent) {
    clauses.push('agent = ?');
    params.push(agent);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM loop_ticks ${where} ORDER BY started_at DESC`).all(...params);
}

export function lastLoopTick(db, agent) {
  return (
    db
      .prepare('SELECT * FROM loop_ticks WHERE agent = ? ORDER BY started_at DESC LIMIT 1')
      .get(agent) ?? null
  );
}

// ---------------------------------------------------------------------------
// Synthetic tasks (docs/autonomy.md): `_proposals` (proposal/review model
// call cost) and `_goals` (human_interventions anchor for goals:set) are both
// "a tasks row ... created on demand" per business, one per (business, name)
// pair. Shared here so proposals.mjs and commands/goals.mjs do not each grow
// their own copy.
// ---------------------------------------------------------------------------

/**
 * Find or create the synthetic tasks row for (businessId, name) - e.g.
 * name '_proposals' or '_goals'. repo is the business id (or 'ledger' when
 * there is none), task_class is `name`, kind 'ops', arm 'control', status
 * 'working'. Idempotent: a second call with the same (businessId, name)
 * returns the existing row rather than inserting a duplicate.
 */
export function ensureSyntheticTask(db, { businessId, name, owner } = {}) {
  const repo = businessId ?? 'ledger';
  const existing = db
    .prepare("SELECT * FROM tasks WHERE repo = ? AND task_class = ? AND kind = 'ops' ORDER BY created_at LIMIT 1")
    .get(repo, name);
  if (existing) return existing;
  return insertTask(db, {
    repo,
    title: `synthetic task ${name} for ${repo}`,
    task_class: name,
    arm: 'control',
    kind: 'ops',
    owner: nullish(owner),
    status: 'working',
    notes: 'synthetic',
  });
}
