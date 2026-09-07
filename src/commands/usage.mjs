// usage:snapshot, usage:delta (docs/cli.md "Packet, measurement, usage").

import { snapshot, delta } from '../usage.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

export function register(registry) {
  registry.add('usage:snapshot', {
    description: 'Manual subscription usage snapshot',
    handler({ db, flags, err }) {
      const need = missing(flags, ['provider', 'plan', 'window', 'used-pct']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const usedPct = Number(flags['used-pct']);
      if (Number.isNaN(usedPct)) return fail(err, 1, 'usage', `--used-pct must be a number, got ${flags['used-pct']}`);

      const row = snapshot(db, {
        provider: flags.provider,
        plan: flags.plan,
        window_kind: flags.window,
        used_pct: usedPct,
        resets_at: flags['resets-at'],
        task_id: flags.task,
        phase: flags.phase,
        source: 'manual',
      });
      if (flags.json) return { code: 0, stdout: JSON.stringify(row) };
      return { code: 0, stdout: row.id };
    },
  });

  registry.add('usage:delta', {
    description: 'Usage percent consumed by a task per provider, from bracketing snapshots',
    handler({ db, flags, err }) {
      if (!flags.task) return fail(err, 1, 'usage', 'usage:delta requires --task <id>');
      const result = delta(db, flags.task);
      if (flags.json) return { code: 0, stdout: JSON.stringify(result) };
      const lines = Object.entries(result).map(
        ([provider, d]) => `${provider}: ${d.start_pct ?? '?'}% -> ${d.end_pct ?? '?'}%  (delta ${d.delta_pct ?? '?'})`
      );
      return { code: 0, stdout: lines.length ? lines.join('\n') : 'no snapshots for this task' };
    },
  });
}
