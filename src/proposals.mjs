// Proposals (docs/autonomy.md "Proposals"): one agent authors, others review
// support/oppose/revise, a human (or, under the dial, the loop itself)
// approves and converts to a real task through the same insertTask path as
// `task:new`.

import { nowIso, withImmediateTransaction } from './db.mjs';
import {
  insertProposal,
  getProposal,
  listProposals as listProposalsLedger,
  setProposalStatus,
  insertProposalReview,
  listProposalReviews,
  insertTask,
  ensureSyntheticTask,
} from './ledger.mjs';

export const VALID_KINDS = new Set(['task', 'policy', 'tooling', 'experiment']);
export const VALID_VERDICTS = new Set(['support', 'oppose', 'revise']);
const DAY_MS = 24 * 60 * 60 * 1000;

function invalid(message) {
  const e = new Error(message);
  e.code = 1;
  return e;
}

function stateError(message) {
  const e = new Error(message);
  e.code = 6;
  return e;
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export function propose(db, config, fields) {
  if (!VALID_KINDS.has(fields.kind)) {
    throw invalid(`kind must be one of ${[...VALID_KINDS].join(', ')}, got ${fields.kind}`);
  }
  if (!fields.author) throw invalid('author is required');
  if (!fields.business) throw invalid('business is required');
  if (!fields.title) throw invalid('title is required');

  return insertProposal(db, {
    author: fields.author,
    business_id: fields.business,
    goal_metric: fields.metric,
    kind: fields.kind,
    title: fields.title,
    rationale: fields.rationale,
    expected_impact: fields.expectedImpact,
    estimated_usd: fields.usd !== undefined && fields.usd !== null ? Number(fields.usd) : null,
    estimated_hours: fields.hours !== undefined && fields.hours !== null ? Number(fields.hours) : null,
    task_class: fields.taskClass,
  });
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

/** An agent may not review its own proposal (docs/autonomy.md "Rules"). */
export function review(db, config, { id, reviewer, verdict, note, confidence }) {
  const proposal = getProposal(db, id);
  if (!proposal) throw invalid(`no such proposal: ${id}`);
  if (!VALID_VERDICTS.has(verdict)) {
    throw invalid(`verdict must be one of ${[...VALID_VERDICTS].join(', ')}, got ${verdict}`);
  }
  if (proposal.author === reviewer) {
    throw stateError(`agent ${reviewer} authored proposal ${id} and may not review its own proposal`);
  }

  const row = insertProposalReview(db, {
    proposal_id: id,
    reviewer,
    verdict,
    note,
    confidence: confidence !== undefined && confidence !== null ? Number(confidence) : null,
  });

  if (proposal.status === 'proposed') {
    setProposalStatus(db, id, 'under_review');
  }

  return { review: row, proposal: getProposal(db, id) };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export function listProposals(db, { status, business, author, kind } = {}) {
  return listProposalsLedger(db, { status, businessId: business, author, kind });
}

// ---------------------------------------------------------------------------
// canAutoApprove (docs/autonomy.md "The autonomy dial")
// ---------------------------------------------------------------------------

/**
 * Implements the dial exactly: kind must be in auto_approve_kinds AND be
 * `task` (policy and tooling proposals are never auto approved regardless of
 * the dial, per doc); estimated_usd strictly under auto_approve_below_usd
 * (0 means never); at least min_reviews supporting reviews; no opposing
 * review at all.
 */
export function canAutoApprove(config, proposal, reviews) {
  const a = config.autonomy;
  if (proposal.kind !== 'task') return false;
  if (!a.auto_approve_kinds.includes(proposal.kind)) return false;
  if (typeof proposal.estimated_usd !== 'number' || !(proposal.estimated_usd < a.auto_approve_below_usd)) return false;
  const supporting = reviews.filter((r) => r.verdict === 'support').length;
  const opposing = reviews.filter((r) => r.verdict === 'oppose').length;
  if (opposing > 0) return false;
  return supporting >= a.min_reviews;
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

/**
 * Converts through the same code path as task:new (insertTask). Requires
 * min_reviews supporting reviews and no opposing review, unless --force.
 * `by` is a human id normally, or the agent name when the loop auto approves
 * under the dial (docs/autonomy.md "auto approved by the loop itself").
 *
 * Review round 1, F1: the status/review-count checks and the conversion
 * (insertTask + setProposalStatus) are one `BEGIN IMMEDIATE` transaction
 * (src/db.mjs's withImmediateTransaction), so two concurrent `approve` calls
 * on the same proposal - a human and the loop's own auto approval
 * (src/loop.mjs's tryAutoApprove), or two loop ticks racing - can no longer
 * both observe "not yet converted" and both insert a task.
 */
export function approve(db, config, { id, by, note, force = false }) {
  const outcome = withImmediateTransaction(db, () => {
    const proposal = getProposal(db, id);
    if (!proposal) return { ok: false, code: 1, message: `no such proposal: ${id}` };
    if (['converted', 'rejected', 'expired'].includes(proposal.status)) {
      return { ok: false, code: 6, message: `proposal ${id} is already ${proposal.status}` };
    }

    const reviews = listProposalReviews(db, { proposalId: id });
    const supporting = reviews.filter((r) => r.verdict === 'support').length;
    const opposing = reviews.filter((r) => r.verdict === 'oppose').length;

    if (supporting < config.autonomy.min_reviews) {
      return {
        ok: false,
        code: 6,
        message: `proposal ${id} has ${supporting} supporting review(s), needs ${config.autonomy.min_reviews}`,
      };
    }
    if (opposing > 0 && !force) {
      return { ok: false, code: 6, message: `proposal ${id} has an opposing review; pass --force to approve anyway` };
    }

    const task = insertTask(db, {
      repo: proposal.business_id,
      title: proposal.title,
      task_class: proposal.task_class ?? 'autonomy',
      arm: config.autonomy.default_arm,
      owner: config.autonomy.default_owner,
      kind: proposal.kind,
      notes: `proposal=${proposal.id}`,
    });

    const updated = setProposalStatus(db, id, 'converted', {
      converted_task_id: task.id,
      decided_by: by,
      decided_at: nowIso(),
      decision_note: note,
    });

    return { ok: true, task, proposal: updated };
  });

  if (!outcome.ok) {
    throw outcome.code === 1 ? invalid(outcome.message) : stateError(outcome.message);
  }
  return { task: outcome.task, proposal: outcome.proposal };
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

export function reject(db, config, { id, by, note }) {
  const proposal = getProposal(db, id);
  if (!proposal) throw invalid(`no such proposal: ${id}`);
  const updated = setProposalStatus(db, id, 'rejected', { decided_by: by, decided_at: nowIso(), decision_note: note });
  return { proposal: updated };
}

// ---------------------------------------------------------------------------
// expireStale
// ---------------------------------------------------------------------------

/** Proposals with status 'proposed' older than config.autonomy.proposal_ttl_days move to 'expired'. */
export function expireStale(db, config, now = new Date()) {
  const cutoffMs = now.getTime() - config.autonomy.proposal_ttl_days * DAY_MS;
  const stale = listProposalsLedger(db, { status: 'proposed' }).filter((p) => Date.parse(p.created_at) < cutoffMs);
  for (const p of stale) setProposalStatus(db, p.id, 'expired');
  return stale.map((p) => p.id);
}

// ---------------------------------------------------------------------------
// synthetic `_proposals` task (docs/autonomy.md)
// ---------------------------------------------------------------------------

export function ensureProposalsTask(db, businessId, owner) {
  return ensureSyntheticTask(db, { businessId, name: '_proposals', owner });
}
