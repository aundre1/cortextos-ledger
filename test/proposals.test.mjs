import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, migrate } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { makeTempDb, makeTempDir } from './helpers.mjs';
import { getTask } from '../src/ledger.mjs';
import { propose, review, listProposals, approve, reject, expireStale, canAutoApprove } from '../src/proposals.mjs';

async function migrated(autonomyOverrides = {}) {
  const db = openDb(makeTempDb());
  await migrate(db);
  const config = loadConfig({ cwd: makeTempDir() });
  config.autonomy = { ...config.autonomy, ...autonomyOverrides };
  return { db, config };
}

function baseProposal(overrides = {}) {
  return {
    author: 'architect', business: 'biz-a', kind: 'task', title: 'Add a signup form',
    rationale: 'closes the paying_customers gap', expectedImpact: 'more signups',
    usd: 1, hours: 2, taskClass: 'feature', ...overrides,
  };
}

test('propose: validates kind and required fields', async () => {
  const { db, config } = await migrated();
  const row = propose(db, config, baseProposal());
  assert.match(row.id, /^p_/);
  assert.equal(row.status, 'proposed');
  assert.throws(() => propose(db, config, baseProposal({ kind: 'bogus' })), /kind must be one of/);
});

test('review: an agent may not review its own proposal', async () => {
  const { db, config } = await migrated();
  const p = propose(db, config, baseProposal({ author: 'architect' }));
  assert.throws(() => review(db, config, { id: p.id, reviewer: 'architect', verdict: 'support' }), /may not review its own/);
});

test('review: a valid review moves a proposed proposal to under_review', async () => {
  const { db, config } = await migrated();
  const p = propose(db, config, baseProposal({ author: 'architect' }));
  const { proposal } = review(db, config, { id: p.id, reviewer: 'builder', verdict: 'support', note: 'looks good', confidence: 0.8 });
  assert.equal(proposal.status, 'under_review');
});

test('review: rejects an invalid verdict', async () => {
  const { db, config } = await migrated();
  const p = propose(db, config, baseProposal());
  assert.throws(() => review(db, config, { id: p.id, reviewer: 'builder', verdict: 'bogus' }), /verdict must be one of/);
});

test('approve: refused below min_reviews', async () => {
  const { db, config } = await migrated({ min_reviews: 2 });
  const p = propose(db, config, baseProposal());
  review(db, config, { id: p.id, reviewer: 'builder', verdict: 'support' });
  assert.throws(() => approve(db, config, { id: p.id, by: 'owner1' }), /needs 2/);
});

test('approve: an opposing review blocks approval unless --force', async () => {
  const { db, config } = await migrated({ min_reviews: 1 });
  const p = propose(db, config, baseProposal());
  review(db, config, { id: p.id, reviewer: 'builder', verdict: 'support' });
  review(db, config, { id: p.id, reviewer: 'reviewer', verdict: 'oppose', note: 'too risky' });
  assert.throws(() => approve(db, config, { id: p.id, by: 'owner1' }), /opposing review/);

  const { task, proposal } = approve(db, config, { id: p.id, by: 'owner1', force: true, note: 'overriding' });
  assert.equal(proposal.status, 'converted');
  assert.equal(proposal.converted_task_id, task.id);
});

test('approve: converts through insertTask and links converted_task_id both ways', async () => {
  const { db, config } = await migrated();
  const p = propose(db, config, baseProposal({ business: 'biz-a', taskClass: 'feature' }));
  review(db, config, { id: p.id, reviewer: 'builder', verdict: 'support' });

  const { task, proposal } = approve(db, config, { id: p.id, by: 'owner1', note: 'go' });
  assert.equal(proposal.status, 'converted');
  assert.equal(proposal.converted_task_id, task.id);
  assert.equal(proposal.decided_by, 'owner1');

  const stored = getTask(db, task.id);
  assert.equal(stored.title, p.title);
  assert.equal(stored.arm, config.autonomy.default_arm);
  assert.equal(stored.owner, config.autonomy.default_owner);
  assert.equal(stored.notes, `proposal=${p.id}`);
});

test('approve: refuses a proposal that is already converted, rejected, or expired', async () => {
  const { db, config } = await migrated();
  const p = propose(db, config, baseProposal());
  reject(db, config, { id: p.id, by: 'owner1', note: 'no' });
  assert.throws(() => approve(db, config, { id: p.id, by: 'owner1' }), /already rejected/);
});

test('expireStale: proposed proposals older than the ttl move to expired; under_review does not', async () => {
  const { db, config } = await migrated({ proposal_ttl_days: 1 });
  const p1 = propose(db, config, baseProposal());
  const p2 = propose(db, config, baseProposal({ title: 'second' }));
  review(db, config, { id: p2.id, reviewer: 'builder', verdict: 'support' }); // moves p2 to under_review

  db.prepare("UPDATE proposals SET created_at = '2000-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(p1.id, p2.id);

  const expired = expireStale(db, config, new Date());
  assert.deepEqual(expired, [p1.id]);
  assert.equal(listProposals(db, {}).find((p) => p.id === p1.id).status, 'expired');
  assert.equal(listProposals(db, {}).find((p) => p.id === p2.id).status, 'under_review');
});

test('canAutoApprove: truth table', async () => {
  const { config } = await migrated({ auto_approve_below_usd: 2, min_reviews: 1 });
  const support = [{ verdict: 'support' }];
  const oppose = [{ verdict: 'support' }, { verdict: 'oppose' }];

  assert.equal(canAutoApprove(config, { kind: 'task', estimated_usd: 1 }, support), true);
  assert.equal(canAutoApprove(config, { kind: 'task', estimated_usd: 2 }, support), false, 'strictly under the threshold');
  assert.equal(canAutoApprove(config, { kind: 'task', estimated_usd: 1 }, []), false, 'needs min_reviews supporting');
  assert.equal(canAutoApprove(config, { kind: 'task', estimated_usd: 1 }, oppose), false, 'any oppose blocks it');
  assert.equal(canAutoApprove(config, { kind: 'policy', estimated_usd: 1 }, support), false, 'policy is never auto approved');
  assert.equal(canAutoApprove(config, { kind: 'tooling', estimated_usd: 1 }, support), false, 'tooling is never auto approved');

  const dialOff = { ...config, autonomy: { ...config.autonomy, auto_approve_below_usd: 0 } };
  assert.equal(canAutoApprove(dialOff, { kind: 'task', estimated_usd: 0 }, support), false, 'dial at 0 never approves');
});

test('F5: canAutoApprove never approves a negative/non-finite estimated_usd, even with the dial fully off (auto_approve_below_usd: 0)', async () => {
  // Codex round, F5 (major): the original check was
  // `estimated_usd < auto_approve_below_usd` - with the dial at its
  // documented "never" value of 0, a NEGATIVE estimate (`-1 < 0`) evaluated
  // true and slipped straight through, auto-approving a task the operator
  // had explicitly turned auto-approval off for. Reproduced with the dial
  // both off (0) and on (2, the truth table's own threshold above) to prove
  // the bypass was not specific to the "0 means never" sentinel alone - a
  // negative estimate defeats ANY positive threshold too, since it is
  // "under" every one of them.
  const { config } = await migrated({ auto_approve_below_usd: 2, min_reviews: 1 });
  const support = [{ verdict: 'support' }];
  const dialOff = { ...config, autonomy: { ...config.autonomy, auto_approve_below_usd: 0 } };

  assert.equal(
    canAutoApprove(dialOff, { kind: 'task', estimated_usd: -1 }, support),
    false,
    'a negative estimate must not bypass the dial being fully off'
  );
  assert.equal(
    canAutoApprove(config, { kind: 'task', estimated_usd: -1 }, support),
    false,
    'a negative estimate must not auto-approve even under a normal positive threshold'
  );
  assert.equal(
    canAutoApprove(config, { kind: 'task', estimated_usd: -Infinity }, support),
    false,
    '-Infinity is "under" every threshold and must still be refused'
  );
  assert.equal(
    canAutoApprove(config, { kind: 'task', estimated_usd: NaN }, support),
    false,
    'NaN must still be refused (already true pre-fix, kept as a guard against regressing it)'
  );
});

test('F5: propose rejects a negative or non-finite --usd outright, at the point the proposal is authored', async () => {
  const { db, config } = await migrated();
  assert.throws(
    () => propose(db, config, baseProposal({ usd: -1 })),
    /usd must be a non-negative finite number/
  );
  assert.throws(
    () => propose(db, config, baseProposal({ usd: NaN })),
    /usd must be a non-negative finite number/
  );
  assert.throws(
    () => propose(db, config, baseProposal({ usd: 'not-a-number' })),
    /usd must be a non-negative finite number/
  );
  // A genuine zero estimate is a legitimate, non-negative value and must
  // still be accepted (this is a value check, not a truthiness check).
  const free = propose(db, config, baseProposal({ usd: 0 }));
  assert.equal(free.estimated_usd, 0);
});

test('CLI: propose / proposal:review / proposal:list / proposal:approve / proposal:reject', async () => {
  const { runCli } = await import('./helpers.mjs');
  const dir = makeTempDir();
  const configPath = `${dir}/cortex-ledger.json`;
  const fs = await import('node:fs');
  fs.writeFileSync(configPath, JSON.stringify({ db: './ledger.db', runs: './runs' }));
  const cli = (args) => runCli(['--config', configPath, ...args]);

  assert.equal(cli(['init']).code, 0);

  const propose1 = cli(['propose', '--author', 'architect', '--business', 'biz-a', '--kind', 'task', '--title', 'Do a thing', '--rationale', 'because', '--impact', 'grows x', '--usd', '1']);
  assert.equal(propose1.code, 0, propose1.stderr);
  const proposalId = propose1.stdout.trim();
  assert.match(proposalId, /^p_/);

  const selfReview = cli(['proposal:review', '--id', proposalId, '--reviewer', 'architect', '--verdict', 'support']);
  assert.notEqual(selfReview.code, 0);

  const review1 = cli(['proposal:review', '--id', proposalId, '--reviewer', 'builder', '--verdict', 'support']);
  assert.equal(review1.code, 0, review1.stderr);

  const list = cli(['proposal:list', '--business', 'biz-a']);
  assert.match(list.stdout, new RegExp(proposalId));

  const approveResult = cli(['proposal:approve', '--id', proposalId, '--by', 'owner1']);
  assert.equal(approveResult.code, 0, approveResult.stderr);
  assert.match(approveResult.stdout.trim(), /^t_/);

  const propose2 = cli(['propose', '--author', 'architect', '--business', 'biz-a', '--kind', 'task', '--title', 'Do another', '--rationale', 'because', '--impact', 'grows y']);
  const id2 = propose2.stdout.trim();
  const rejectResult = cli(['proposal:reject', '--id', id2, '--by', 'owner1', '--note', 'not now']);
  assert.equal(rejectResult.code, 0, rejectResult.stderr);
});
