// The heartbeat loop (docs/autonomy.md "The loop"). One call to tick() is
// one bounded action for one agent: refuse if autonomy is off, expire stale
// proposals, execute an already-assigned action, otherwise draft or review a
// proposal, then always write a loop_ticks row. Every autonomous action goes
// through the same commands a human would run (run:launch, review:brief,
// run:end, ingest), spawned exactly like test/helpers.mjs's runCli does, so
// every hard limit, guard, and quota check still applies unchanged.
//
// Deviation from the doc's six numbered steps, logged in the wave log and
// the final report: an extra "3.5" check runs between "execute the assigned
// action" and "draft a proposal" - if any open proposal (in scope) is
// already eligible for auto approval under the dial, approve and convert it
// before drafting something new. The doc's "Autonomy dial" section says the
// loop itself performs this approval but never names which of the six steps
// it belongs to.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nowIso } from './db.mjs';
import {
  listTasks,
  listRuns,
  listProposalReviews,
  insertLoopTick,
  insertCost,
  insertIntervention,
  listLoopTicks,
  ensureSyntheticTask,
} from './ledger.mjs';
import { deriveNextAction } from './packet.mjs';
import { loadGoals, fillMetrics } from './goals.mjs';
import { selectForPacket } from './lessons.mjs';
import { getAdapter } from './adapters/index.mjs';
import {
  VALID_KINDS,
  VALID_VERDICTS,
  propose,
  review,
  listProposals,
  approve,
  canAutoApprove,
  expireStale,
  ensureProposalsTask,
} from './proposals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_PATH = join(ROOT, 'bin', 'cortexctl.mjs');
const PROMPTS_DIR = join(ROOT, 'prompts');
const OPEN_TASK_STATUSES = new Set(['submitted', 'working', 'input_required']);
const OPEN_PROPOSAL_STATUSES = ['proposed', 'under_review'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Config flags for a spawned child command. When `config` was loaded from a
 * real file, forward that same file so the child resolves db/runs/limits/
 * agents/autonomy identically. When it was not (a caller built `config` in
 * memory, as several unit tests do), materialize a throwaway config file
 * under config.runs instead of falling back to just `--db` - otherwise the
 * child would resolve every other field (`runs` in particular) against its
 * own cwd's defaults instead of the caller's, and spray `.cortex/runs/...`
 * into whatever directory happens to be the test runner's cwd.
 */
function baseArgs(config) {
  if (config.configPath) return ['--config', config.configPath];
  mkdirSync(config.runs, { recursive: true });
  const tmpConfigPath = join(config.runs, '.loop-child-config.json');
  writeFileSync(
    tmpConfigPath,
    JSON.stringify({
      db: config.db, runs: config.runs, limits: config.limits, test_patterns: config.test_patterns,
      providers: config.providers, agents: config.agents, autonomy: config.autonomy, goals: config.goals,
    })
  );
  return ['--config', tmpConfigPath];
}

/** Spawn `node bin/cortexctl.mjs <args> <config/db>` and collect the result - the same real CLI a human would run. */
function execChild(config, args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args, ...baseArgs(config)], {
    env: process.env,
    encoding: 'utf8',
    shell: false,
  });
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: result.stderr ?? '' };
}

function safeReadOut(outDir) {
  try {
    return readFileSync(join(outDir, 'out.txt'), 'utf8');
  } catch {
    return '';
  }
}

/** Adapter/provider/model for a direct (non run:launch) adapter call: config.agents[agent], with fake-friendly fallbacks. */
function resolveRunAgent(config, agentName, adapterOverride) {
  const agentConfig = config.agents?.[agentName] ?? {};
  const adapterName = adapterOverride ?? agentConfig.adapter ?? 'fake';
  const provider = agentConfig.provider ?? 'fake';
  const model = agentConfig.model ?? (adapterName === 'fake' ? 'fake-model' : null);
  return { adapterName, provider, model };
}

function validateProposalDraft(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['proposal draft is not an object'] };
  if (!VALID_KINDS.has(obj.kind)) errors.push(`kind must be one of ${[...VALID_KINDS].join(', ')}, got ${JSON.stringify(obj.kind)}`);
  if (typeof obj.title !== 'string' || !obj.title.trim()) errors.push('title is required');
  if (typeof obj.rationale !== 'string' || !obj.rationale.trim()) errors.push('rationale is required');
  if (obj.estimated_usd != null && typeof obj.estimated_usd !== 'number') errors.push('estimated_usd must be a number');
  if (obj.estimated_hours != null && typeof obj.estimated_hours !== 'number') errors.push('estimated_hours must be a number');
  return { ok: errors.length === 0, errors };
}

function validateReviewDraft(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['review draft is not an object'] };
  if (!VALID_VERDICTS.has(obj.verdict)) errors.push(`verdict must be one of ${[...VALID_VERDICTS].join(', ')}, got ${JSON.stringify(obj.verdict)}`);
  if (typeof obj.note !== 'string' || !obj.note.trim()) errors.push('note is required');
  if (obj.confidence != null && (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)) {
    errors.push('confidence must be a number between 0 and 1');
  }
  return { ok: errors.length === 0, errors };
}

function budgetExhausted(db, maxUsd) {
  if (maxUsd === undefined || maxUsd === null) return false;
  const total = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM loop_ticks').get().total;
  return total >= maxUsd;
}

// ---------------------------------------------------------------------------
// Step 3: execute the one action already assigned to this agent
// ---------------------------------------------------------------------------

/** A live (running/unset status) run whose done.marker has already appeared - the adapter finished, the ledger has not caught up. */
function liveRunWithDoneMarker(config, task, runs) {
  const live = runs.find((r) => r.status === 'running' || r.status == null);
  if (!live) return null;
  const outDir = live.out_dir || join(config.runs, task.id, live.agent);
  return existsSync(join(outDir, 'done.marker')) ? { run: live, outDir } : null;
}

function tryAssignedAction(db, config, { agent, adapterOverride }) {
  const myTasks = listTasks(db, { owner: agent }).filter((t) => OPEN_TASK_STATUSES.has(t.status));
  for (const task of myTasks) {
    const runs = listRuns(db, task.id);
    const done = liveRunWithDoneMarker(config, task, runs);
    if (done) {
      const end = execChild(config, ['run:end', '--run', done.run.id]);
      if (end.code !== 0) return { action: 'run_end_failed', taskId: task.id, note: end.stderr.trim().slice(0, 300) };
      const eventsPath = join(done.outDir, 'events.jsonl');
      if (existsSync(eventsPath)) {
        execChild(config, ['ingest', '--events', eventsPath, '--task', task.id, '--run', done.run.id]);
      }
      return { action: 'run_end', taskId: task.id, note: `run:end + ingest for run ${done.run.id}` };
    }

    const nextAction = deriveNextAction(db, config, task);
    if (nextAction.actor !== 'agent') continue;

    const isReviewer = nextAction.action.includes('reviewer');
    const targetAgent = isReviewer ? 'reviewer' : task.arm === 'control' ? 'solo' : 'builder';
    const { adapterName, provider, model } = resolveRunAgent(config, targetAgent, adapterOverride);
    if (!model) return { action: 'run_launch_failed', taskId: task.id, note: `no model resolved for agent ${targetAgent}` };

    if (isReviewer) {
      const brief = execChild(config, ['review:brief', '--task', task.id, '--reviewer', 'reviewer']);
      if (brief.code !== 0) return { action: 'review_brief_failed', taskId: task.id, note: brief.stderr.trim().slice(0, 300) };
    }

    const promptDir = join(config.runs, task.id, 'loop');
    mkdirSync(promptDir, { recursive: true });
    const promptPath = join(promptDir, `${targetAgent}-prompt.txt`);
    writeFileSync(promptPath, `${task.title}\n\n${task.notes ?? ''}\n`.trim() + '\n');

    const launch = execChild(config, [
      'run:launch', '--task', task.id, '--agent', targetAgent,
      '--adapter', adapterName, '--provider', provider, '--model', model,
      '--prompt-file', promptPath,
      // `--sync` (review round 1, F2): the loop's very next tick expects
      // done.marker to already exist for this run (liveRunWithDoneMarker
      // above) - true for the fake adapter's fixtures, which finish
      // instantly, but not something a detached real harness could promise,
      // so this only applies when the adapter actually is fake.
      ...(adapterName === 'fake' ? ['--sync'] : []),
    ]);
    if (launch.code !== 0) return { action: 'run_launch_failed', taskId: task.id, note: launch.stderr.trim().slice(0, 300) };
    return { action: isReviewer ? 'run_launch_reviewer' : 'run_launch', taskId: task.id, note: `run ${launch.stdout}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step "3.5": auto approve an eligible proposal under the dial
// ---------------------------------------------------------------------------

function tryAutoApprove(db, config, { agent, business }) {
  const scope = business ? { business } : {};
  const candidates = [
    ...listProposals(db, { status: 'proposed', ...scope }),
    ...listProposals(db, { status: 'under_review', ...scope }),
  ];
  for (const p of candidates) {
    const reviews = listProposalReviews(db, { proposalId: p.id });
    if (canAutoApprove(config, p, reviews)) {
      const result = approve(db, config, { id: p.id, by: agent, note: 'auto approved by the loop under the autonomy dial' });
      return { action: 'auto_approved', proposalId: p.id, taskId: result.task.id, note: `converted to task ${result.task.id}` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 4: propose
// ---------------------------------------------------------------------------

async function tryPropose(db, config, { agent, business, adapterOverride }) {
  // Every condition below is a silent "nothing to draft right now" (not an
  // action worth a loop_ticks row): tick() falls through to step 5 when this
  // returns null, same as when there is simply no open proposal to review.
  if (!business) return null;

  const authoredOpen = listProposals(db, { author: agent }).filter((p) => OPEN_PROPOSAL_STATUSES.includes(p.status));
  if (authoredOpen.length >= config.autonomy.max_open_proposals_per_agent) return null;

  const filled = fillMetrics(db, config, loadGoals(config));
  const biz = filled.businesses.find((b) => b.id === business);
  if (!biz) return null;

  const retroPath = join(config.runs, 'retro', business, 'retro.json');
  const retroJson = existsSync(retroPath) ? JSON.parse(readFileSync(retroPath, 'utf8')) : null;
  const context = {
    business: biz,
    open_proposals: listProposals(db, { business }),
    retro: retroJson,
    lessons: selectForPacket(db, config, { taskClass: null, actor: 'all' }),
  };
  const prompt = `${readFileSync(join(PROMPTS_DIR, 'proposer.md'), 'utf8')}\n\n## Context\n\n${JSON.stringify(context, null, 2)}\n`;

  const { adapterName, provider, model } = resolveRunAgent(config, agent, adapterOverride);
  const adapter = await getAdapter(adapterName);
  const outDir = join(config.runs, '_proposals', agent, `${Date.now()}`);
  const result = await adapter.run({
    prompt, cwd: config.runs, agent, model, outDir,
    timeoutMs: config.limits.wallclock_s * 1000, env: process.env,
  });
  const costUsd = result.costUsd ?? 0;

  const proposalsTask = ensureProposalsTask(db, business, config.autonomy.default_owner);
  if (costUsd) {
    insertCost(db, {
      task_id: proposalsTask.id, provider, model, cost_usd: costUsd,
      tokens_in: result.tokensIn ?? 0, tokens_out: result.tokensOut ?? 0, requests: result.requests ?? 1, source: 'proposal',
    });
  }

  const text = result.text ?? safeReadOut(outDir);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { action: 'proposal_invalid', costUsd, note: `invalid JSON from proposer: ${text.slice(0, 200)}` };
  }
  const validation = validateProposalDraft(obj);
  if (!validation.ok) {
    return { action: 'proposal_invalid', costUsd, note: validation.errors.join('; ') };
  }

  const row = propose(db, config, {
    author: agent, business, kind: obj.kind, title: obj.title, rationale: obj.rationale,
    expectedImpact: obj.expected_impact, metric: obj.goal_metric ?? undefined,
    usd: obj.estimated_usd, hours: obj.estimated_hours, taskClass: obj.task_class ?? undefined,
  });
  return { action: 'proposed', proposalId: row.id, costUsd, note: row.title };
}

// ---------------------------------------------------------------------------
// Step 5: review one open proposal by another agent
// ---------------------------------------------------------------------------

async function tryReview(db, config, { agent, business, adapterOverride }) {
  const scope = business ? { business } : {};
  const reviewedIds = new Set(listProposalReviews(db, { reviewer: agent }).map((r) => r.proposal_id));
  const candidates = [
    ...listProposals(db, { status: 'proposed', ...scope }),
    ...listProposals(db, { status: 'under_review', ...scope }),
  ].filter((p) => p.author !== agent && !reviewedIds.has(p.id));
  if (!candidates.length) return null;
  const target = candidates[0];

  const filled = fillMetrics(db, config, loadGoals(config));
  const biz = filled.businesses.find((b) => b.id === target.business_id) ?? null;
  const context = {
    proposal: target,
    business: biz,
    open_proposals: listProposals(db, { business: target.business_id }),
    lessons: selectForPacket(db, config, { taskClass: target.task_class, actor: 'all' }),
  };
  const prompt = `${readFileSync(join(PROMPTS_DIR, 'proposal-reviewer.md'), 'utf8')}\n\n## Context\n\n${JSON.stringify(context, null, 2)}\n`;

  const { adapterName, provider, model } = resolveRunAgent(config, agent, adapterOverride);
  const adapter = await getAdapter(adapterName);
  const outDir = join(config.runs, '_proposals', agent, `${Date.now()}`);
  const result = await adapter.run({
    prompt, cwd: config.runs, agent, model, outDir,
    timeoutMs: config.limits.wallclock_s * 1000, env: process.env,
  });
  const costUsd = result.costUsd ?? 0;

  const proposalsTask = ensureProposalsTask(db, target.business_id, config.autonomy.default_owner);
  if (costUsd) {
    insertCost(db, {
      task_id: proposalsTask.id, provider, model, cost_usd: costUsd,
      tokens_in: result.tokensIn ?? 0, tokens_out: result.tokensOut ?? 0, requests: result.requests ?? 1, source: 'review',
    });
  }

  const text = result.text ?? safeReadOut(outDir);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { action: 'proposal_invalid', proposalId: target.id, costUsd, note: `invalid JSON from reviewer: ${text.slice(0, 200)}` };
  }
  const validation = validateReviewDraft(obj);
  if (!validation.ok) {
    return { action: 'proposal_invalid', proposalId: target.id, costUsd, note: validation.errors.join('; ') };
  }

  review(db, config, { id: target.id, reviewer: agent, verdict: obj.verdict, note: obj.note, confidence: obj.confidence });
  return { action: 'reviewed', proposalId: target.id, costUsd, note: obj.verdict };
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

/**
 * One bounded action for `agent` (docs/autonomy.md "The loop"). Always
 * inserts a loop_ticks row (step 6), even when nothing happens (action
 * 'noop'). Throws Error(.code = 6) when config.autonomy.enabled is false -
 * no rows are written in that case.
 */
export async function tick(db, config, { agent, business, maxUsd, now = new Date(), adapterOverride } = {}) {
  if (!config.autonomy.enabled) {
    const e = new Error('autonomy is disabled (config.autonomy.enabled = false); nothing to do');
    e.code = 6;
    throw e;
  }
  if (!agent) throw new Error('tick requires an agent');

  const startedAt = now.toISOString();
  const firstEver = listLoopTicks(db, {}).length === 0;
  if (firstEver) {
    const anchor = ensureSyntheticTask(db, { businessId: business, name: '_loop', owner: config.autonomy.default_owner });
    insertIntervention(db, { task_id: anchor.id, kind: 'note', detail: `autonomy enabled: first loop tick (agent ${agent})` });
  }

  const finish = (outcome) => {
    const row = insertLoopTick(db, {
      agent,
      started_at: startedAt,
      ended_at: nowIso(),
      action: outcome.action,
      task_id: outcome.taskId ?? null,
      proposal_id: outcome.proposalId ?? null,
      cost_usd: outcome.costUsd ?? 0,
      note: outcome.note ?? null,
    });
    return {
      action: outcome.action,
      taskId: outcome.taskId ?? null,
      proposalId: outcome.proposalId ?? null,
      costUsd: outcome.costUsd ?? 0,
      note: outcome.note ?? null,
      tickId: row.id,
    };
  };

  // 2. Expire stale proposals.
  expireStale(db, config, now);

  // 3. Execute one already-assigned action, if any.
  const assigned = tryAssignedAction(db, config, { agent, adapterOverride });
  if (assigned) return finish(assigned);

  // 3.5 (deviation, see module header). Auto approve an eligible proposal.
  const autoApproved = tryAutoApprove(db, config, { agent, business });
  if (autoApproved) return finish(autoApproved);

  const budgetSpent = budgetExhausted(db, maxUsd);

  // 4. Nothing assigned: draft a proposal.
  if (config.autonomy.propose && !budgetSpent) {
    const proposed = await tryPropose(db, config, { agent, business, adapterOverride });
    if (proposed) return finish(proposed);
  }

  // 5. Review one open proposal by another agent.
  if (config.autonomy.review_proposals && !budgetSpent) {
    const reviewed = await tryReview(db, config, { agent, business, adapterOverride });
    if (reviewed) return finish(reviewed);
  }

  return finish({ action: 'noop', note: budgetSpent ? 'max_usd reached' : 'nothing to do' });
}
