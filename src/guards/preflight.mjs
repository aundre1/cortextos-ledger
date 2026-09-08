// Preflight guard (docs/guards.md "Preflight (before any agent starts)",
// docs/state-machine.md "Exit codes"). Invoked directly via `cortexctl
// preflight` and automatically by `run:start` unless --no-preflight.

import { spawnSync } from 'node:child_process';

import { getTask } from '../ledger.mjs';
import { sqliteAvailable } from '../db.mjs';
import { escalate, checkQuota } from '../limits.mjs';
import { scan } from './secrets-scan.mjs';
import { resolveConfiguredCommand } from '../adapters/resolve-command.mjs';

function nodeVersionOk() {
  const [majorStr, minorStr] = process.versions.node.split('.');
  const major = Number(majorStr);
  const minor = Number(minorStr);
  return major > 22 || (major === 22 && minor >= 5);
}

/**
 * @returns {Promise<{ok, code, reason, detail, findings}>} code is one of
 * 0 (pass), 1 (node/node:sqlite missing), 2 (dirty worktree or secrets), or
 * 4 (quota exhausted or public_only refused).
 */
export async function preflight(db, config, opts = {}) {
  const {
    worktree,
    provider,
    model = null,
    isPublic = false,
    allowDirty = false,
    strict = false,
    taskId,
    adapterName = null,
    // Test-only injection points for command resolution (default: the real
    // process platform/env) - see test/guards.test.mjs "command resolution"
    // for why this needs to be overridable: resolveCommand is a deliberate
    // no-op on every non-win32 platform (docs/adapters.md rule 1), so the
    // `command_not_found` refusal below can only be exercised at all by
    // injecting platform: 'win32'.
    platform = process.platform,
    env = process.env,
  } = opts;

  // 1. Node version and node:sqlite availability (docs/guards.md).
  if (!nodeVersionOk()) {
    return {
      ok: false,
      code: 1,
      reason: 'node_version',
      detail: `node >= 22.5 required, got ${process.versions.node}`,
      findings: [],
    };
  }
  const sqlite = sqliteAvailable();
  if (!sqlite.ok) {
    return {
      ok: false,
      code: 1,
      reason: 'node_version',
      detail: `node:sqlite not available: ${sqlite.error}`,
      findings: [],
    };
  }

  // 1b. Command resolution (docs/adapters.md "Windows command resolution"):
  // when the caller names the adapter the run needs (run:start/run:launch
  // always do; the standalone `preflight` command does only when given
  // --adapter), refuse before any git/filesystem work when the harness that
  // adapter would spawn cannot be found anywhere on PATH at all
  // (resolveConfiguredCommand's resolvedFrom === null - rule f in
  // resolve-command.mjs). `fake` never spawns a real harness, so it is
  // never checked here. No escalation row is written - like `node_version`
  // above, docs/ledger.md's escalations.reason enum has no slot for this
  // failure mode, so it is reported only in this function's own return
  // value and on the CLI, exactly as `node_version` already does for a
  // different missing-prerequisite failure.
  if (adapterName && adapterName !== 'fake') {
    const adapterConfig = config.adapters?.[adapterName] ?? {};
    const resolution = resolveConfiguredCommand(adapterName, {
      cmd: adapterConfig.cmd,
      toolOverride: config.tools?.[adapterName],
      platform,
      env,
    });
    if (resolution.resolvedFrom === null) {
      const pathEntries = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
      return {
        ok: false,
        code: 1,
        reason: 'command_not_found',
        detail: `${adapterName} not found on PATH (searched ${pathEntries.length} entr${pathEntries.length === 1 ? 'y' : 'ies'}); set config.tools.${adapterName} or config.adapters.${adapterName}.cmd to override`,
        findings: [],
      };
    }
  }

  // 2. Dirty worktree. Untracked files are allowed unless --strict; a
  // tracked change always refuses unless --allow-dirty.
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktree,
    shell: false,
    encoding: 'utf8',
  });
  const lines = (status.stdout ?? '').split('\n').filter(Boolean);
  const tracked = lines.filter((l) => !l.startsWith('??'));
  const untracked = lines.filter((l) => l.startsWith('??'));
  const isDirty = tracked.length > 0 || (strict && untracked.length > 0);

  if (isDirty && !allowDirty) {
    const detail = `${tracked.length} tracked change(s), ${untracked.length} untracked file(s) in ${worktree}`;
    if (taskId) escalate(db, { taskId, reason: 'dirty_worktree', severity: 'halt', detail });
    return { ok: false, code: 2, reason: 'dirty_worktree', detail, findings: [] };
  }
  if (isDirty && allowDirty && taskId) {
    // Record the override in notes so it is visible in the ledger, per
    // docs/guards.md.
    const task = getTask(db, taskId);
    if (task) {
      const note = 'allow_dirty';
      const notes = task.notes ? `${task.notes}; ${note}` : note;
      db.prepare('UPDATE tasks SET notes = ? WHERE id = ?').run(notes, taskId);
    }
  }

  // 3. Secrets in tree.
  const findings = scan(worktree);
  if (findings.length > 0) {
    const detail = `${findings.length} potential secret(s): ${findings
      .map((f) => `${f.path}:${f.line ?? '-'} (${f.pattern})`)
      .join(', ')}`;
    if (taskId) escalate(db, { taskId, reason: 'secrets', severity: 'halt', detail });
    return { ok: false, code: 2, reason: 'secrets', detail, findings };
  }

  // 4. Provider quota and public_only. The escalation reason is always
  // 'quota' (docs/ledger.md's enum has no separate public_only value); the
  // returned `reason` still distinguishes the two for the CLI message.
  const quota = checkQuota(db, config, provider, model, 0, { isPublic });
  if (!quota.ok) {
    if (taskId) {
      escalate(db, { taskId, reason: 'quota', severity: 'halt', detail: quota.detail ?? quota.reason });
    }
    return { ok: false, code: 4, reason: quota.reason, detail: quota.detail ?? '', findings: [] };
  }

  return { ok: true, code: 0, reason: null, detail: null, findings: [] };
}
