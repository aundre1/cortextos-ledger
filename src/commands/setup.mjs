// Setup commands: init, config:show, limits, quota:set, quota:tick,
// quota:show, purge (docs/cli.md "Setup" and "Packet, measurement, usage").

import { migrate, pendingMigrations, schemaVersion } from '../db.mjs';
import { upsertQuota, listQuota } from '../ledger.mjs';
import { tickQuota, rollQuota, windowEndsAt } from '../quota.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

function quotaRowView(row) {
  return {
    ...row,
    headroom_requests: row.limit_requests != null ? row.limit_requests - row.used_requests : null,
    headroom_usd: row.limit_usd != null ? row.limit_usd - row.used_usd : null,
    resets_at: windowEndsAt(row),
  };
}

export function register(registry) {
  registry.add('init', {
    description: 'Create the database, apply pending migrations, print schema version',
    async handler({ db, flags, out }) {
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
    handler({ db, flags, err }) {
      const need = missing(flags, ['provider']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
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
    description: 'All windows with headroom and reset time',
    handler({ db, flags }) {
      rollQuota(db);
      const rows = listQuota(db).map(quotaRowView);
      if (flags.json) return { code: 0, stdout: JSON.stringify(rows) };
      if (!rows.length) return { code: 0, stdout: 'no quota windows configured' };
      const lines = rows.map((r) => {
        const model = r.model ?? '*';
        const reqPart = r.limit_requests != null ? `requests ${r.used_requests}/${r.limit_requests}` : '';
        const usdPart = r.limit_usd != null ? `usd ${r.used_usd.toFixed(2)}/${r.limit_usd.toFixed(2)}` : '';
        return `${r.provider} ${model} ${r.window_kind}  ${[reqPart, usdPart].filter(Boolean).join('  ')}  resets ${r.resets_at}`;
      });
      return { code: 0, stdout: lines.join('\n') };
    },
  });

  // Test cleanup only (docs/cli.md "purge --task <id> --confirm"): delete a
  // task and every row across the other task-scoped tables that reference
  // it. Children first, task row last, since `foreign_keys = ON` (src/db.mjs)
  // would otherwise refuse the parent delete.
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
    description: 'Delete a task and its rows (test cleanup only)',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      if (!flags.confirm) {
        return fail(err, 1, 'usage', 'purge requires --confirm (deletes a task and all its rows)');
      }
      const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);

      for (const table of PURGE_CHILD_TABLES) {
        db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(flags.task);
      }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(flags.task);
      return { code: 0, stdout: 'ok' };
    },
  });
}
