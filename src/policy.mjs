// Routing policy (docs/autonomy.md "Policy proposals"): the only mechanism
// that changes `config.agents` routing without editing the config file by
// hand. `apply` re-computes its supporting run count from the ledger at
// apply time (never trusting a count carried on the proposal), `revert`
// deactivates a policy, and `activeFor` is what run:start consults before
// falling back to config.agents.

import { nowIso } from './db.mjs';
import { getProposal, setProposalStatus, insertPolicy, listPolicy as listPolicyLedger, getPolicy, setPolicyActive } from './ledger.mjs';
import { report } from './measure.mjs';

const SUPPORTING_RUNS_MIN = 20;

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

/** Adjudicated run count for a task class, recomputed from the ledger now (docs/autonomy.md, docs/measurement.md's same 20-run threshold). */
export function supportingRunCount(db, config, taskClass) {
  const result = report(db, config, { taskClass });
  const row = result.classes.find((c) => c.task_class === taskClass);
  return row ? row.adjudicated_count : 0;
}

/**
 * `proposalId` must name a `policy` kind proposal; its `task_class` names
 * the class the override applies to. `overrides` is the agent_overrides
 * object to write (e.g. { reviewer: { provider: 'openai', model: '...' } }).
 * Refused (code 6) when the recomputed supporting run count is under 20.
 */
export function apply(db, config, { proposalId, by, overrides, now = new Date() }) {
  const proposal = getProposal(db, proposalId);
  if (!proposal) throw invalid(`no such proposal: ${proposalId}`);
  if (proposal.kind !== 'policy') {
    throw invalid(`proposal ${proposalId} is kind ${proposal.kind}, policy:apply requires kind policy`);
  }
  if (!proposal.task_class) throw invalid(`proposal ${proposalId} has no task_class`);

  const count = supportingRunCount(db, config, proposal.task_class);
  if (count < SUPPORTING_RUNS_MIN) {
    throw stateError(
      `task_class ${proposal.task_class} has ${count} adjudicated run(s), needs at least ${SUPPORTING_RUNS_MIN} to apply a routing policy`
    );
  }

  const row = insertPolicy(db, {
    applied_at: now.toISOString(),
    proposal_id: proposalId,
    task_class: proposal.task_class,
    agent_overrides_json: JSON.stringify(overrides ?? {}),
    applied_by: by,
    active: 1,
  });

  setProposalStatus(db, proposalId, 'approved', {
    decided_by: by,
    decided_at: nowIso(),
    decision_note: `routing policy applied: ${row.id}`,
  });

  return { policy: row };
}

export function revert(db, { id }) {
  const existing = getPolicy(db, id);
  if (!existing) throw invalid(`no such policy: ${id}`);
  return setPolicyActive(db, id, 0);
}

export function listPolicy(db, { taskClass, active } = {}) {
  return listPolicyLedger(db, { taskClass, active });
}

/**
 * The active policy's agent overrides for a task class, or null. run:start
 * consults this before config.agents (docs/autonomy.md "Policy proposals").
 * When more than one active row exists for the same class (should not
 * normally happen), the most recently applied one wins.
 */
export function activeFor(db, taskClass) {
  if (!taskClass) return null;
  const rows = listPolicyLedger(db, { taskClass, active: 1 });
  if (!rows.length) return null;
  const row = rows[0]; // listPolicy orders by applied_at DESC
  let overrides = {};
  try {
    overrides = JSON.parse(row.agent_overrides_json);
  } catch {
    overrides = {};
  }
  return { id: row.id, taskClass: row.task_class, overrides };
}
