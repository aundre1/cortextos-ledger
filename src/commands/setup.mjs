// Setup commands: init, config:show, limits, quota:set, quota:tick,
// quota:show, purge (docs/cli.md "Setup" and "Packet, measurement, usage").

import { migrate, pendingMigrations, schemaVersion } from '../db.mjs';
import { upsertQuota, listQuota } from '../ledger.mjs';
import { tickQuota, rollQuota, windowEndsAt, syncConfigQuota, findQuotaRow, reservedSpend } from '../quota.mjs';
import { sweepTmpDir } from '../tmp-sweep.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

// Round 3, F1(b): `reserved_usd` is the pessimistic in-flight spend this
// window is already carrying (see src/quota.mjs `reservedSpend`) - every run
// currently `running` for this row's provider, assumed to cost up to
// `config.limits.spend_usd` each, since its real cost is unknown until
// ingest. Shown so an operator sees why a refusal happened, not only the
// raw `used_usd`/`limit_usd` numbers (docs/guards.md "Reserved spend and
// requests").
function quotaRowView(db, config, row) {
  return {
    ...row,
    headroom_requests: row.limit_requests != null ? row.limit_requests - row.used_requests : null,
    headroom_usd: row.limit_usd != null ? row.limit_usd - row.used_usd : null,
    reserved_usd: reservedSpend(db, config, row.provider),
    resets_at: windowEndsAt(row),
    // 'config' (seeded/refreshed from config.providers.<name>.windows and
    // never touched by quota:set) or 'manual' (quota:set's own override, or
    // an earlier synced row it has since claimed) - see src/quota.mjs
    // "Config-derived ceilings" for the precedence rule.
    origin: row.source === 'manual' ? 'quota:set' : 'config',
  };
}

export function register(registry) {
  registry.add('init', {
    description: 'Create the database, apply pending migrations, print schema version',
    async handler({ db, config, flags, out }) {
      // Blind review NF3: sweep any stale <runs>/.tmp/ leftovers (an
      // unredacted PR diff from a task:new capture that never finished
      // because cortexctl itself was killed mid-stream) on every init call,
      // dry-run included - this is disk cleanup, not part of the "pending
      // SQL" dry-run reports, and a dry-run caller benefits from the same
      // guarantee as a real one.
      sweepTmpDir(config.runs);

      if (flags['dry-run']) {
        const pending = pendingMigrations(db);
        if (flags.json) {
          return { code: 0, stdout: JSON.stringify({ pending: pending.map((m) => m.version) }) };
        }
        for (const m of pending) out(`${m.version}  (${m.file})`);
        if (!pending.length) out('no pending migrations');
        return { code: 0 };
      }

      const applied = await migrate(db);
      const version = schemaVersion(db);
      if (flags.json) {
        return { code: 0, stdout: JSON.stringify({ applied, schema_version: version }) };
      }
      out(`schema version: ${version}`);
      return { code: 0 };
    },
  });

  registry.add('config:show', {
    description: 'Print resolved config with paths made absolute',
    handler({ config, flags }) {
      const view = { ...config };
      delete view.configPath;
      if (flags.json) return { code: 0, stdout: JSON.stringify(view) };
      return { code: 0, stdout: JSON.stringify(view, null, 2) };
    },
  });

  registry.add('limits', {
    description: 'Print effective limits',
    handler({ config, flags }) {
      if (flags.json) return { code: 0, stdout: JSON.stringify(config.limits) };
      return { code: 0, stdout: JSON.stringify(config.limits, null, 2) };
    },
  });

  registry.add('quota:set', {
    description: 'Upsert a quota window',
    handler({ db, flags, err }) {
      const need = missing(flags, ['provider', 'window']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const row = upsertQuota(db, {
        provider: flags.provider,
        model: flags.model ?? null,
        window_kind: flags.window,
        limit_requests: flags['limit-requests'] !== undefined ? Number(flags['limit-requests']) : undefined,
        limit_usd: flags['limit-usd'] !== undefined ? Number(flags['limit-usd']) : undefined,
        source: 'manual',
      });
      if (flags.json) return { code: 0, stdout: JSON.stringify(row) };
      return { code: 0, stdout: 'ok' };
    },
  });

  registry.add('quota:tick', {
    description: 'Manual usage increment',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['provider']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      // A window declared only in the config file (never `quota:set`) needs
      // a provider_quota row to exist before it can be ticked at all.
      syncConfigQuota(db, config);
      const ticked = tickQuota(db, {
        provider: flags.provider,
        model: flags.model ?? null,
        requests: flags.requests !== undefined ? Number(flags.requests) : 0,
        usd: flags.usd !== undefined ? Number(flags.usd) : 0,
      });
      if (flags.json) return { code: 0, stdout: JSON.stringify({ ticked }) };
      return { code: 0, stdout: 'ok' };
    },
  });

  registry.add('quota:show', {
    description: 'All windows with headroom, reserved spend, reset time, and origin (config or quota:set)',
    handler({ db, config, flags }) {
      // Seed/refresh config-derived windows first so an operator who has
      // never run quota:set still sees every ceiling docs/architecture.md's
      // `providers.<name>.windows` declares, not an empty table that reads
      // as "no limit".
      syncConfigQuota(db, config);
      rollQuota(db);
      const rows = listQuota(db).map((row) => quotaRowView(db, config, row));
      if (flags.json) return { code: 0, stdout: JSON.stringify(rows) };
      if (!rows.length) return { code: 0, stdout: 'no quota windows configured' };
      const lines = rows.map((r) => {
        const model = r.model ?? '*';
        const reqPart = r.limit_requests != null ? `requests ${r.used_requests}/${r.limit_requests}` : '';
        const usdPart =
          r.limit_usd != null
            ? `usd ${r.used_usd.toFixed(2)}/${r.limit_usd.toFixed(2)} (reserved ${r.reserved_usd.toFixed(2)})`
            : '';
        return `${r.provider} ${model} ${r.window_kind}  ${[reqPart, usdPart].filter(Boolean).join('  ')}  resets ${r.resets_at}  origin ${r.origin}`;
      });
      return { code: 0, stdout: lines.join('\n') };
    },
  });

  registry.add('quota:clear', {
    description: 'Delete a provider_quota window row (any source) - see docs/guards.md "Removing a window from config"',
    handler({ db, flags, err }) {
      const need = missing(flags, ['provider', 'window']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const model = flags.model ?? null;
      const row = findQuotaRow(db, { provider: flags.provider, model, windowKind: flags.window });
      if (!row) {
        const detail = `no such quota window: ${flags.provider} ${model ?? '*'} ${flags.window}`;
        if (flags.json) return { code: 0, stdout: JSON.stringify({ deleted: null }) };
        return { code: 0, stdout: detail };
      }
      db.prepare('DELETE FROM provider_quota WHERE id = ?').run(row.id);
      if (flags.json) return { code: 0, stdout: JSON.stringify({ deleted: row }) };
      return {
        code: 0,
        stdout: `deleted ${row.provider} ${row.model ?? '*'} ${row.window_kind} (source ${row.source}, used_requests ${row.used_requests}, used_usd ${row.used_usd})`,
      };
    },
  });

  // Test cleanup only (docs/cli.md "purge --task <id> --confirm"): delete a
  // task and every row across the other task-scoped tables that reference
  // it. Children first, task row last, since `foreign_keys = ON` (src/db.mjs)
  // would otherwise refuse the parent delete.
  //
  // Blocker 2 (owner's explicit instruction): purge is IRREVERSIBLE - it
  // deletes rows outright, with no undo - and `task:archive` is the intended
  // way to set work aside instead (src/commands/tasks.mjs, migration
  // 009-v02-archive.mjs). Both the `--confirm` usage message below and this
  // command's own description now say so plainly, and purge refuses outright
  // (exit 6, docs/state-machine.md "Task is in a state that does not allow
  // the command" - the same code `task:archive` itself uses when it refuses
  // to archive a task with a run still running) unless the task is already
  // archived - nothing can be deleted through this command without having
  // been archived first, so an operator cannot lose work to purge by
  // accident the way `task:archive`'s absence used to allow.
  const PURGE_CHILD_TABLES = [
    'task_runs',
    'agent_messages',
    'artifacts',
    'review_verdicts',
    'test_results',
    'cost_usage',
    'escalations',
    'human_interventions',
    'usage_snapshots',
  ];

  registry.add('purge', {
    description:
      'Irreversibly delete an already-archived task and its rows (test cleanup only) - task:archive is the intended way to set work aside; purge refuses a task that is not already archived',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      if (!flags.confirm) {
        return fail(
          err,
          1,
          'usage',
          'purge requires --confirm (this IRREVERSIBLY DELETES a task and all its rows, with no undo - use task:archive to set work aside instead)'
        );
      }
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      if (!task.archived_at) {
        return fail(
          err,
          6,
          'not_archived',
          `task ${flags.task} must be archived first (cortexctl task:archive --task ${flags.task} --reason "..."); purge never un-archives on its own and deletes irreversibly`
        );
      }

      for (const table of PURGE_CHILD_TABLES) {
        db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(flags.task);
      }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(flags.task);
      return { code: 0, stdout: 'ok' };
    },
  });
}
