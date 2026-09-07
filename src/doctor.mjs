// "Why did my agent go dark" (docs/cli.md "Doctor"), without reading a raw
// transcript. Pure-ish: reads the db and a run's out-dir files, never writes.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { schemaVersion, pendingMigrations } from './db.mjs';
import { getTask, listEscalations, countRuns, sumCost, listQuota, lastLoopTick } from './ledger.mjs';
import { rollQuota, windowEndsAt } from './quota.mjs';
import { deriveNextAction, computeLimits } from './packet.mjs';
import { redact } from './adapters/credential-boundary.mjs';

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

function nodeVersionOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
}

function readLastNonEmptyLine(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1] : null;
}

function readLastEvent(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runOutDir(config, run) {
  return run.out_dir || join(config.runs, run.task_id, run.agent);
}

// ---------------------------------------------------------------------------
// Per-run diagnosis
// ---------------------------------------------------------------------------

function diagnoseRun(db, config, run, now) {
  const findings = [];
  const outDir = runOutDir(config, run);

  const pidPath = join(outDir, 'pid.txt');
  const donePath = join(outDir, 'done.marker');
  const exitPath = join(outDir, 'exit.txt');
  const eventsPath = join(outDir, 'events.jsonl');
  const outPath = join(outDir, 'out.txt');

  const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : null;
  const alive = processAlive(pid);
  findings.push({ level: 'info', text: `pid.txt: ${pid ?? 'missing'} (${alive ? 'alive' : 'not running'})` });

  const donePresent = existsSync(donePath);
  findings.push({ level: 'info', text: `done.marker: ${donePresent ? 'present' : 'missing'}` });

  const exitPresent = existsSync(exitPath);
  const exitCode = exitPresent ? readFileSync(exitPath, 'utf8').trim() : null;
  findings.push({ level: 'info', text: `exit.txt: ${exitPresent ? exitCode : 'missing'}` });

  const lastEvent = readLastEvent(eventsPath);
  let eventAgeMs = null;
  if (lastEvent && lastEvent.ts) {
    eventAgeMs = now.getTime() - Date.parse(lastEvent.ts);
  }
  findings.push({
    level: 'info',
    text: lastEvent
      ? `events.jsonl last event: ${lastEvent.type} (${eventAgeMs != null ? Math.round(eventAgeMs / 1000) + 's ago' : 'unknown age'})`
      : 'events.jsonl: missing or empty',
  });

  const lastOutLine = readLastNonEmptyLine(outPath);
  findings.push({
    level: 'info',
    text: `out.txt last line: ${lastOutLine ? redact(lastOutLine) : '(missing or empty)'}`,
  });

  const watchdogEscalations = listEscalations(db, run.task_id).filter(
    (e) => e.run_id === run.id && (e.reason === 'wallclock' || e.reason === 'stall')
  );
  findings.push({ level: watchdogEscalations.length ? 'warn' : 'info', text: `watchdog escalations: ${watchdogEscalations.length}` });

  rollQuota(db, now);
  const quotaRows = listQuota(db, { provider: run.provider });
  const exhausted = quotaRows.filter(
    (q) => (q.limit_requests != null && q.used_requests >= q.limit_requests) || (q.limit_usd != null && q.used_usd >= q.limit_usd)
  );
  findings.push({
    level: exhausted.length ? 'warn' : 'info',
    text: `quota windows for ${run.provider}: ${quotaRows.length}, exhausted: ${exhausted.length}`,
  });

  const startedMs = run.started_at ? Date.parse(run.started_at) : null;
  const wallclockLimitS = run.wallclock_limit_s ?? config.limits.wallclock_s;
  const elapsedS = startedMs != null ? (now.getTime() - startedMs) / 1000 : null;
  const pastWallclock = elapsedS != null && elapsedS > wallclockLimitS;
  findings.push({
    level: pastWallclock ? 'warn' : 'info',
    text: `elapsed ${elapsedS != null ? Math.round(elapsedS) + 's' : '?'} vs wallclock limit ${wallclockLimitS}s`,
  });

  // Probable cause rules, in the order docs/cli.md's Doctor section gives them.
  let probableCause = null;
  let resolveCommand = null;
  const lastEventIsModelCall = lastEvent && lastEvent.type === 'message';
  const lastEventIsUnresolvedToolCall = lastEvent && lastEvent.type === 'tool.call';

  if (exhausted.length && lastEventIsModelCall) {
    probableCause = 'quota';
    resolveCommand = 'cortexctl quota:show';
  } else if (!alive && !donePresent && !exitPresent) {
    probableCause = 'killed externally or machine slept';
    resolveCommand = `cortexctl run:end --run ${run.id} --exit 137 --summary "killed externally or machine slept"`;
  } else if (lastEventIsUnresolvedToolCall) {
    probableCause = 'tool hang';
    resolveCommand = `cortexctl intervene --task ${run.task_id} --run ${run.id} --kind rescue --detail "tool hang on ${lastEvent.tool ?? 'unknown tool'}"`;
  } else if (pastWallclock && !watchdogEscalations.length) {
    probableCause = 'watchdog missing';
    resolveCommand = `cortexctl run:end --run ${run.id}`;
  }

  return { findings, probableCause, resolveCommand };
}

// ---------------------------------------------------------------------------
// Per-task diagnosis
// ---------------------------------------------------------------------------

function diagnoseTask(db, config, task) {
  const findings = [];
  const limits = computeLimits(db, config, task);
  findings.push({ level: 'info', text: `attempts ${limits.attempts_used}/${limits.attempts_max}` });
  findings.push({ level: 'info', text: `spend $${limits.spend_used_usd.toFixed(2)}/$${limits.spend_max_usd.toFixed(2)}` });

  const open = listEscalations(db, task.id).filter((e) => !e.resolved_at);
  findings.push({ level: open.length ? 'warn' : 'info', text: `open escalations: ${open.length}` });
  for (const e of open) findings.push({ level: e.severity === 'halt' ? 'warn' : 'info', text: `  ${e.reason} (${e.severity})` });

  const nextAction = deriveNextAction(db, config, task);
  findings.push({ level: 'info', text: `next_action: [${nextAction.actor}] ${nextAction.action}` });

  let probableCause = null;
  let resolveCommand = null;
  if (task.status === 'input_required' && open.length) {
    probableCause = open[open.length - 1].reason;
    resolveCommand = nextAction.command;
  }

  return { findings, probableCause, resolveCommand };
}

// ---------------------------------------------------------------------------
// --all
// ---------------------------------------------------------------------------

function diagnoseAll(db, config, now) {
  const findings = [];
  const stallS = config.limits.stall_s;

  const runningRuns = db.prepare("SELECT * FROM task_runs WHERE status = 'running' OR status IS NULL").all();
  for (const run of runningRuns) {
    const eventsPath = join(runOutDir(config, run), 'events.jsonl');
    const lastEvent = readLastEvent(eventsPath);
    const ageS = lastEvent && lastEvent.ts ? (now.getTime() - Date.parse(lastEvent.ts)) / 1000 : Infinity;
    if (ageS > stallS) {
      findings.push({ level: 'warn', text: `run ${run.id} (task ${run.task_id}) stalled: no event for ${Math.round(ageS)}s` });
    }
  }

  const inputRequired = db.prepare("SELECT id, title FROM tasks WHERE status = 'input_required'").all();
  for (const t of inputRequired) {
    findings.push({ level: 'warn', text: `task ${t.id} is input_required: ${t.title}` });
  }

  rollQuota(db, now);
  const quotaRows = listQuota(db);
  for (const q of quotaRows) {
    const pctRequests = q.limit_requests ? q.used_requests / q.limit_requests : 0;
    const pctUsd = q.limit_usd ? q.used_usd / q.limit_usd : 0;
    if (Math.max(pctRequests, pctUsd) >= 0.9) {
      findings.push({
        level: 'warn',
        text: `quota ${q.provider} ${q.model ?? '*'} ${q.window_kind} at ${Math.round(Math.max(pctRequests, pctUsd) * 100)}% (resets ${windowEndsAt(q)})`,
      });
    }
  }

  // Autonomy (docs/autonomy.md "The loop"): every agent named in
  // config.agents plus every agent that has ever ticked, so a stalled
  // heartbeat (an agent in config.agents with no recent tick) is visible
  // too, not only agents that happen to have ticked at least once.
  const tickedAgents = db.prepare('SELECT DISTINCT agent FROM loop_ticks').all().map((r) => r.agent);
  const configuredAgents = Object.keys(config.agents ?? {});
  const agents = [...new Set([...configuredAgents, ...tickedAgents])].sort();
  for (const agent of agents) {
    const last = lastLoopTick(db, agent);
    if (!last) {
      findings.push({ level: 'info', text: `loop ${agent}: no tick recorded yet` });
    } else {
      const ageS = Math.round((now.getTime() - Date.parse(last.ended_at ?? last.started_at)) / 1000);
      findings.push({
        level: 'info',
        text: `loop ${agent}: last tick ${last.action} ${ageS}s ago, cost $${(last.cost_usd ?? 0).toFixed(4)}`,
      });
    }
  }

  if (!findings.length) findings.push({ level: 'info', text: 'nothing stalled, no tasks input_required, no quota window over 90%' });
  return { findings };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export function doctor(db, config, { taskId, runId, all, now = new Date() } = {}) {
  const findings = [];
  let probableCause = null;
  let resolveCommand = null;

  findings.push({
    level: nodeVersionOk() ? 'info' : 'warn',
    text: `node ${process.versions.node} (need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for node:sqlite)`,
  });

  const pending = pendingMigrations(db);
  findings.push({
    level: pending.length ? 'warn' : 'info',
    text: `schema version ${schemaVersion(db) ?? '(none applied)'}, pending migrations: ${pending.length}`,
  });

  if (runId) {
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId);
    if (!run) {
      findings.push({ level: 'warn', text: `no such run: ${runId}` });
    } else {
      const r = diagnoseRun(db, config, run, now);
      findings.push(...r.findings);
      probableCause = probableCause ?? r.probableCause;
      resolveCommand = resolveCommand ?? r.resolveCommand;
    }
  }

  if (taskId) {
    const task = getTask(db, taskId);
    if (!task) {
      findings.push({ level: 'warn', text: `no such task: ${taskId}` });
    } else {
      const r = diagnoseTask(db, config, task);
      findings.push(...r.findings);
      probableCause = probableCause ?? r.probableCause;
      resolveCommand = resolveCommand ?? r.resolveCommand;
    }
  }

  if (all) {
    const r = diagnoseAll(db, config, now);
    findings.push(...r.findings);
  }

  const text = findings.map((f) => `[${f.level}] ${f.text}`).join('\n');
  const withCause =
    text +
    (probableCause ? `\n\nprobable cause: ${probableCause}` : '') +
    (resolveCommand ? `\nresolve: ${resolveCommand}` : '');

  return { findings, probableCause, resolveCommand, text: withCause };
}
