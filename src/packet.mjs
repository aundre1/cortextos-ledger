// Context packet: the "where we left off" boot brief (docs/context-packet.md).
// buildTaskPacket / buildBoardPacket are pure (db, config) -> { json, markdown,
// truncated }; writePacket is the only function here that touches disk or the
// ledger, and only when told to (src/commands/packet.mjs calls it).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getTask,
  listTasks,
  listRuns,
  listVerdicts,
  listTests,
  listEscalations,
  countRuns,
  sumCost,
  insertArtifact,
  insertMessage,
} from './ledger.mjs';
import { selectForPacket } from './lessons.mjs';

const OPEN_STATUSES = ['submitted', 'working', 'input_required'];
const TERMINAL_STATUSES = ['completed', 'canceled', 'failed', 'rejected'];
const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 };

// ---------------------------------------------------------------------------
// Small ledger reads that src/ledger.mjs does not expose a helper for
// (per the project rule: db.prepare directly for anything a helper lacks).
// ---------------------------------------------------------------------------

function retryAuthorizedCount(db, taskId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM human_interventions WHERE task_id = ? AND kind = 'retry_authorized'")
    .get(taskId).c;
}

function artifactsForTask(db, taskId) {
  // Newest first, so "artifacts beyond the newest three" is a simple slice.
  return db
    .prepare('SELECT kind, path, bytes FROM artifacts WHERE task_id = ? ORDER BY created_at DESC')
    .all(taskId);
}

function rawMessagesForTask(db, taskId, limit) {
  // Newest first (raw rows); buildTaskPacket reverses the kept slice back to
  // chronological order for display.
  return db
    .prepare('SELECT * FROM agent_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(taskId, limit);
}

// ---------------------------------------------------------------------------
// View shaping
// ---------------------------------------------------------------------------

function taskView(t) {
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    task_class: t.task_class,
    arm: t.arm,
    repo: t.repo,
    issue_number: t.issue_number,
    pr_number: t.pr_number,
    status: t.status,
    outcome: t.outcome,
    owner: t.owner,
    priority: t.priority,
    due_at: t.due_at,
    base_commit: t.base_commit,
    branch: t.branch,
    worktree: t.worktree,
  };
}

function runView(r) {
  const elapsed_s =
    r.ended_at && r.started_at
      ? Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)
      : null;
  return {
    id: r.id,
    seq: r.seq,
    agent: r.agent,
    model: r.model,
    status: r.status,
    exit_code: r.exit_code,
    elapsed_s,
    cost_usd: r.cost_usd,
    halted_reason: r.halted_reason,
    summary: r.summary,
  };
}

function messageView(m) {
  return {
    at: m.created_at,
    from: m.sender,
    to: m.recipient,
    kind: m.kind,
    excerpt: (m.body ?? '').slice(0, 300),
  };
}

/** Findings from a verdict row's findings_json, ordered blocker > major > minor > nit. */
function sortedFindings(verdictRow) {
  let findings = [];
  try {
    const parsed = JSON.parse(verdictRow.findings_json ?? '{}');
    findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    findings = [];
  }
  return [...findings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
  );
}

// ---------------------------------------------------------------------------
// Limits and next_action (shared by the task packet and, for next_action, the
// board packet's per-task line).
// ---------------------------------------------------------------------------

export function computeLimits(db, config, task) {
  const attemptsUsed = countRuns(db, task.id, ['builder', 'solo']);
  const attemptsMax = config.limits.builder_attempts_max + retryAuthorizedCount(db, task.id);
  const challengesUsed = db
    .prepare('SELECT COUNT(*) AS c FROM review_verdicts WHERE task_id = ? AND challenge_seq > 0')
    .get(task.id).c;
  return {
    attempts_used: attemptsUsed,
    attempts_max: attemptsMax,
    spend_used_usd: sumCost(db, task.id),
    spend_max_usd: config.limits.spend_usd,
    challenges_used: challengesUsed,
    challenges_max: config.limits.challenge_cycles_max,
    wallclock_s: config.limits.wallclock_s,
  };
}

/**
 * next_action is derived, never stored (docs/context-packet.md). Rules,
 * in order:
 *   submitted             -> start the build agent (builder for tri, solo for control)
 *   working, live run     -> wait
 *   working, build done,
 *     tri, no verdict yet -> start reviewer
 *   working, verdict is
 *     changes_requested,
 *     attempts left       -> start build agent again
 *   input_required        -> human resolves the named escalation
 *   completed/terminal    -> nothing
 * Anything else is ambiguous: actor 'human', action explains why.
 */
export function deriveNextAction(db, config, task) {
  const id = task.id;
  const buildAgent = task.arm === 'control' ? 'solo' : 'builder';

  if (TERMINAL_STATUSES.includes(task.status)) {
    return { actor: 'none', action: `nothing: task is ${task.status}`, command: null };
  }

  if (task.status === 'input_required') {
    const open = listEscalations(db, id).filter((e) => !e.resolved_at);
    const esc = open[open.length - 1];
    if (!esc) {
      return {
        actor: 'human',
        action: 'task is input_required but no open escalation was found; inspect manually',
        command: `cortexctl task:show ${id}`,
      };
    }
    const retryFlag = esc.reason === 'retry_limit' ? ' --retry-authorized' : '';
    return {
      actor: 'human',
      action: `resolve escalation ${esc.reason}, then run:start ${buildAgent} again`,
      command: `cortexctl task:resolve --task ${id}${retryFlag} --note "resolve ${esc.reason}"`,
    };
  }

  if (task.status === 'submitted') {
    return {
      actor: 'agent',
      action: `start ${buildAgent}`,
      command: `cortexctl run:start --task ${id} --agent ${buildAgent}`,
    };
  }

  if (task.status === 'working') {
    const runs = listRuns(db, id);
    const live = runs.find((r) => r.status === 'running' || r.status == null);
    if (live) {
      return { actor: 'system', action: `wait for run ${live.id} (${live.agent}) to finish`, command: null };
    }

    const buildRuns = runs.filter((r) => r.agent === buildAgent);
    const lastBuild = buildRuns[buildRuns.length - 1];
    const verdicts = listVerdicts(db, id);
    const lastVerdict = verdicts[verdicts.length - 1];

    if (task.arm === 'tri' && lastBuild && !lastVerdict) {
      return {
        actor: 'agent',
        action: 'start reviewer',
        command: `cortexctl run:start --task ${id} --agent reviewer`,
      };
    }

    if (lastVerdict && lastVerdict.decision === 'changes_requested') {
      const { attempts_used, attempts_max } = computeLimits(db, config, task);
      if (attempts_used < attempts_max) {
        return {
          actor: 'agent',
          action: `start ${buildAgent} attempt ${attempts_used + 1}`,
          command: `cortexctl run:start --task ${id} --agent ${buildAgent}`,
        };
      }
    }

    return {
      actor: 'human',
      action:
        'working state is ambiguous: no live run, no pending reviewer step, and no changes_requested verdict with attempts left',
      command: `cortexctl task:show ${id}`,
    };
  }

  return { actor: 'human', action: `unrecognized task status ${task.status}`, command: `cortexctl task:show ${id}` };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderTaskMarkdown(p) {
  const t = p.task;
  const l = p.limits;
  const lines = [];
  lines.push(`# ${t.id} [${t.status}] ${t.title}`);
  lines.push(`repo ${t.repo}  class ${t.task_class}  arm ${t.arm}  kind ${t.kind}`);
  lines.push('');
  lines.push(
    `limits: attempts ${l.attempts_used}/${l.attempts_max}  spend $${l.spend_used_usd.toFixed(2)}/$${l.spend_max_usd.toFixed(2)}  challenges ${l.challenges_used}/${l.challenges_max}  wallclock ${l.wallclock_s}s`
  );
  lines.push('');
  lines.push(`next action (${p.next_action.actor}): ${p.next_action.action}`);
  if (p.next_action.command) lines.push(p.next_action.command);
  lines.push('');
  if (p.lessons && p.lessons.length) {
    lines.push('Lessons');
    for (const l of p.lessons) lines.push(`  [${l.applies_to}] ${l.lesson} (confidence ${l.confidence})`);
    lines.push('');
  }
  if (p.latest_verdict) {
    lines.push(
      `latest verdict: ${p.latest_verdict.decision}  (${p.latest_verdict.findings_real ?? '?'} real / ${p.latest_verdict.findings_total} total)`
    );
    for (const f of p.latest_verdict.top_findings) {
      lines.push(`  [${f.severity}] ${f.file ?? '-'}: ${f.claim ?? '-'}`);
    }
    lines.push('');
  }
  if (p.tests) {
    lines.push(`last test: ${p.tests.suite} ${p.tests.last_status} (${p.tests.passed} passed, ${p.tests.failed} failed)`);
    lines.push('');
  }
  lines.push(`runs (${p.runs.length}):`);
  for (const r of p.runs) {
    lines.push(
      `  seq ${r.seq}  ${r.agent}  ${r.status ?? 'running'}  exit=${r.exit_code ?? '-'}  cost=$${(r.cost_usd ?? 0).toFixed(2)}${r.elapsed_s != null ? `  ${r.elapsed_s}s` : ''}`
    );
  }
  lines.push('');
  lines.push(`open escalations (${p.open_escalations.length}):`);
  for (const e of p.open_escalations) lines.push(`  ${e.reason} (${e.severity ?? '-'}): ${e.detail ?? ''}`);
  lines.push('');
  lines.push(`artifacts (${p.artifacts.length}):`);
  for (const a of p.artifacts) lines.push(`  ${a.kind}: ${a.path}`);
  return lines.join('\n');
}

function renderBoardMarkdown(p) {
  const lines = [];
  lines.push(`# board${p.owner ? ` (${p.owner})` : ''}`);
  for (const entry of p.tasks) {
    const t = entry.task;
    lines.push(
      `${t.status.padEnd(15)} p${t.priority}  ${t.id}  ${t.owner ?? '-'}  ${t.title} -- next: ${entry.next_action.action}`
    );
  }
  if (!p.tasks.length) lines.push('no open tasks');
  return lines.join('\n');
}

/**
 * Which lessons `applies_to` role best matches a task's next agent action
 * (docs/autonomy.md "Injection": lessons target builder/reviewer/architect/
 * all, but next_action's actor is the coarser agent/human/system/none).
 * 'architect' is the fallback for anything that is not clearly a builder or
 * reviewer step - a human resolving an escalation, or a terminal task, is
 * closest in spirit to the architect's envelope-only view.
 */
function lessonActorForTask(nextAction) {
  if (nextAction.actor !== 'agent') return 'architect';
  if (nextAction.action.includes('reviewer')) return 'reviewer';
  return 'builder';
}

function boardCompare(a, b) {
  const aInputRequired = a.status === 'input_required' ? 0 : 1;
  const bInputRequired = b.status === 'input_required' ? 0 : 1;
  if (aInputRequired !== bInputRequired) return aInputRequired - bInputRequired;
  const ap = a.priority ?? 3;
  const bp = b.priority ?? 3;
  if (ap !== bp) return ap - bp;
  const ad = a.due_at;
  const bd = b.due_at;
  if (ad === bd) return 0;
  if (ad == null) return 1;
  if (bd == null) return -1;
  return ad < bd ? -1 : 1;
}

// ---------------------------------------------------------------------------
// buildTaskPacket
// ---------------------------------------------------------------------------

/**
 * Trimming is measured against the JSON representation (the structure that
 * actually grows with message/artifact/run/finding counts; packet.md never
 * carries messages at all per docs/context-packet.md's markdown ordering, so
 * measuring against markdown bytes could never trigger the "recent_messages"
 * trim step). Order, per "Size discipline": recent_messages entirely, then
 * artifacts beyond the newest three, then runs beyond the newest three, then
 * findings beyond the top three. limits/status/next_action are never trimmed.
 */
export function buildTaskPacket(db, config, taskId, { maxBytes = 8000, now = new Date() } = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  const limits = computeLimits(db, config, task);
  const nextAction = deriveNextAction(db, config, task);

  const allRuns = listRuns(db, taskId).map(runView); // ascending by seq
  const verdicts = listVerdicts(db, taskId);
  const latestVerdictRow = verdicts.length ? verdicts[verdicts.length - 1] : null;
  const allFindings = latestVerdictRow ? sortedFindings(latestVerdictRow) : [];
  const testsRows = listTests(db, taskId);
  const lastTest = testsRows.length ? testsRows[testsRows.length - 1] : null;
  const allArtifacts = artifactsForTask(db, taskId); // newest first
  const openEscalations = listEscalations(db, taskId)
    .filter((e) => !e.resolved_at)
    .map((e) => ({ reason: e.reason, severity: e.severity, detail: e.detail }));
  const allMessages = rawMessagesForTask(db, taskId, 50); // newest first, generous cap
  const lessons = selectForPacket(db, config, { taskClass: task.task_class, actor: lessonActorForTask(nextAction) });

  let messagesLimit = Math.min(allMessages.length, 10);
  let artifactsLimit = allArtifacts.length;
  let runsLimit = allRuns.length;
  let findingsLimit = Math.min(allFindings.length, 3);
  let truncated = false;

  const build = () => {
    const messages = allMessages.slice(0, messagesLimit).slice().reverse().map(messageView);
    const artifacts = allArtifacts.slice(0, artifactsLimit);
    const runs = runsLimit >= allRuns.length ? allRuns : allRuns.slice(allRuns.length - runsLimit);
    const findings = allFindings.slice(0, findingsLimit);
    const jsonObj = {
      packet_version: '1',
      generated_at: now.toISOString(),
      task: taskView(task),
      limits,
      runs,
      latest_verdict: latestVerdictRow
        ? {
            decision: latestVerdictRow.decision,
            findings_total: latestVerdictRow.findings_total,
            findings_real: latestVerdictRow.findings_real,
            top_findings: findings.map((f) => ({ severity: f.severity, file: f.file, claim: f.claim })),
          }
        : null,
      tests: lastTest
        ? { last_status: lastTest.status, passed: lastTest.passed, failed: lastTest.failed, suite: lastTest.suite }
        : null,
      artifacts,
      open_escalations: openEscalations,
      recent_messages: messages,
      lessons: lessons.map((l) => ({ id: l.id, task_class: l.task_class, applies_to: l.applies_to, lesson: l.lesson, confidence: l.confidence })),
      next_action: nextAction,
    };
    return jsonObj;
  };

  let jsonObj = build();
  while (Buffer.byteLength(JSON.stringify(jsonObj), 'utf8') > maxBytes) {
    if (messagesLimit > 0) messagesLimit--;
    else if (artifactsLimit > 3) artifactsLimit--;
    else if (runsLimit > 3) runsLimit--;
    else if (findingsLimit > 0) findingsLimit--;
    else break; // nothing left that is allowed to be trimmed
    truncated = true;
    jsonObj = build();
  }

  jsonObj.truncated = truncated;
  let markdown = renderTaskMarkdown(jsonObj);
  if (truncated) markdown += '\n(truncated)\n';

  return { json: JSON.stringify(jsonObj), markdown, truncated };
}

// ---------------------------------------------------------------------------
// buildBoardPacket
// ---------------------------------------------------------------------------

export function buildBoardPacket(db, config, { owner, maxBytes = 12000 } = {}) {
  const tasks = listTasks(db, { owner }).filter((t) => OPEN_STATUSES.includes(t.status)).sort(boardCompare);
  let entries = tasks.map((t) => ({ task: taskView(t), next_action: deriveNextAction(db, config, t) }));
  let truncated = false;

  const build = () => ({
    packet_version: '1',
    generated_at: new Date().toISOString(),
    owner: owner ?? null,
    tasks: entries,
  });

  let jsonObj = build();
  // A board entry is already one line plus next_action; the only thing left
  // to shed under a byte budget is whole tasks, dropped lowest priority first
  // (the tail, after the input_required/priority/due_at sort above).
  while (Buffer.byteLength(JSON.stringify(jsonObj), 'utf8') > maxBytes && entries.length > 1) {
    entries = entries.slice(0, -1);
    truncated = true;
    jsonObj = build();
  }

  jsonObj.truncated = truncated;
  let markdown = renderBoardMarkdown(jsonObj);
  if (truncated) markdown += '\n(truncated)\n';

  return { json: JSON.stringify(jsonObj), markdown, truncated };
}

// ---------------------------------------------------------------------------
// writePacket
// ---------------------------------------------------------------------------

/**
 * Writes packet.json/packet.md to outDir. When packet.taskId is set (task
 * packets only - artifacts.task_id and agent_messages.task_id are both
 * NOT NULL, so a board packet, which has no task, cannot carry either row;
 * see the OPEN QUESTION appended to the wave log) it also inserts an
 * artifacts row (kind 'packet') and an agent_messages row (kind 'packet',
 * from 'ledger' to the task owner or 'board') so the ledger shows when the
 * packet was handed out.
 */
export function writePacket(db, config, packet, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'packet.json');
  const mdPath = join(outDir, 'packet.md');
  writeFileSync(jsonPath, packet.json);
  writeFileSync(mdPath, packet.markdown);

  if (packet.taskId) {
    insertArtifact(db, { task_id: packet.taskId, kind: 'packet', path: jsonPath });
    insertMessage(db, {
      task_id: packet.taskId,
      sender: 'ledger',
      recipient: packet.owner ?? 'board',
      kind: 'packet',
      body: `packet written to ${jsonPath}`,
    });
  }

  return { files: [jsonPath, mdPath] };
}
