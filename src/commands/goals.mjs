// Goals commands (docs/autonomy.md "Goals contract"): goals:show, goals:set.

import { loadGoals, fillMetrics, setMetric } from '../goals.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

export function register(registry) {
  registry.add('goals:show', {
    description: 'Print the goals contract with ledger sourced metrics filled and a gap per metric',
    handler({ db, config, flags }) {
      const goals = loadGoals(config);
      const filled = fillMetrics(db, config, goals);
      const businesses = flags.business
        ? filled.businesses.filter((b) => b.id === flags.business)
        : filled.businesses;
      const out = { ...filled, businesses };

      if (flags.json) return { code: 0, stdout: JSON.stringify(out) };

      const lines = [];
      if (out.missing) lines.push(`(${out.warning})`);
      for (const b of businesses) {
        lines.push(`# ${b.id} ${b.name ?? ''}`.trim());
        if (b.objective) lines.push(`  objective: ${b.objective}`);
        for (const m of b.metrics ?? []) {
          lines.push(
            `  ${m.name}: current=${m.current ?? '-'} target=${m.target ?? '-'} gap=${m.gap ?? '-'} source=${m.source}${m.note ? ` (${m.note})` : ''}`
          );
        }
      }
      if (!businesses.length) lines.push('no businesses in the goals contract');
      return { code: 0, stdout: lines.join('\n') };
    },
  });

  registry.add('goals:set', {
    description: 'Update a manual metric current value, recording who did it',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['business', 'metric', 'current']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const current = Number(flags.current);
      if (Number.isNaN(current)) return fail(err, 1, 'usage', `--current must be a number, got ${flags.current}`);

      let result;
      try {
        result = setMetric(db, config, { business: flags.business, metric: flags.metric, current, by: flags.by });
      } catch (e) {
        return fail(err, 1, 'not_found', e.message);
      }
      return { code: 0, stdout: result.intervention.id };
    },
  });
}
