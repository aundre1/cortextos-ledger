// Wall clock and stall watchdog (docs/state-machine.md "Wall clock
// watchdog"). `tick()` is the pure, testable unit: given a run row and a
// clock, it decides done/running/wallclock/stall and performs the kill plus
// ledger updates plus escalation. `watch()` is the polling loop that
// `cortexctl watch --run <id>` runs as its own detached process; tests call
// `tick()` directly with synthetic dirs and clocks instead of sleeping.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { nowIso } from '../db.mjs';
import { escalate } from '../limits.mjs';
import { killTree } from '../adapters/spawn.mjs';

function markRun(db, run, status, haltedReason) {
  db.prepare(
    'UPDATE task_runs SET status = ?, halted_reason = ?, ended_at = ? WHERE id = ?'
  ).run(status, haltedReason, nowIso(), run.id);
}

function ensureExitCode(outDir, code) {
  const path = join(outDir, 'exit.txt');
  if (!existsSync(path)) writeFileSync(path, String(code));
}

/**
 * One watchdog poll for a single run row. Returns:
 *   'done'      - done.marker already present, nothing to do
 *   'wallclock' - elapsed exceeded the run's wall clock limit; process tree
 *                 killed, run halted, escalation 'wallclock' (halt)
 *   'stall'     - no event for stall_s; process tree killed, run 'stalled',
 *                 escalation 'stall' (warn - it kills the process but does
 *                 not itself block the task, per docs/state-machine.md)
 *   'running'   - still within both limits
 */
export function tick(db, config, run, nowDate = new Date()) {
  const outDir = run.out_dir;

  if (outDir && existsSync(join(outDir, 'done.marker'))) {
    return 'done';
  }

  const nowMs = nowDate.getTime();
  const startedMs = Date.parse(run.started_at);
  const wallclockLimitS = run.wallclock_limit_s ?? config.limits.wallclock_s;
  const elapsedS = (nowMs - startedMs) / 1000;

  if (elapsedS > wallclockLimitS) {
    killTree(run.pid);
    if (outDir) ensureExitCode(outDir, 137);
    markRun(db, run, 'halted', 'wallclock');
    escalate(db, {
      taskId: run.task_id,
      runId: run.id,
      reason: 'wallclock',
      severity: 'halt',
      detail: `elapsed ${elapsedS.toFixed(0)}s exceeds limit ${wallclockLimitS}s`,
    });
    return 'wallclock';
  }

  const stallS = config.limits.stall_s;
  let lastEventMs = startedMs;
  if (outDir) {
    const eventsPath = join(outDir, 'events.jsonl');
    if (existsSync(eventsPath)) {
      try {
        lastEventMs = statSync(eventsPath).mtimeMs;
      } catch {
        // keep startedMs
      }
    }
  }
  const stallElapsedS = (nowMs - lastEventMs) / 1000;

  if (stallElapsedS > stallS) {
    killTree(run.pid);
    if (outDir) ensureExitCode(outDir, 137);
    markRun(db, run, 'stalled', 'stall');
    escalate(db, {
      taskId: run.task_id,
      runId: run.id,
      reason: 'stall',
      severity: 'warn',
      detail: `no event for ${stallElapsedS.toFixed(0)}s (limit ${stallS}s)`,
    });
    return 'stall';
  }

  return 'running';
}

/**
 * Poll loop for `cortexctl watch --run <id>`. Not itself directly tested
 * (tests exercise `tick()`); `oneTick` lets a caller run exactly one poll
 * without sleeping, which the CLI does not otherwise need.
 */
export async function watch(db, config, { runId, pollMs = 10000, now = () => new Date(), oneTick = false } = {}) {
  for (;;) {
    const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(runId);
    if (!run) return 'not_found';
    const result = tick(db, config, run, now());
    if (result !== 'running' || oneTick) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
