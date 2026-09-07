// Measurement commands (docs/cli.md "Packet, measurement, usage"): compare,
// report, export.

import { compare, report, exportTables } from '../measure.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

export function register(registry) {
  registry.add('compare', {
    description: 'Tri versus control',
    handler({ db, config, flags, err }) {
      if (!flags.issue && !flags.pr && !flags.task) {
        return fail(err, 1, 'usage', 'compare requires --issue <n>, --pr <n>, or --task <id>');
      }
      const result = compare(db, config, {
        issue: flags.issue !== undefined ? Number(flags.issue) : undefined,
        pr: flags.pr !== undefined ? Number(flags.pr) : undefined,
        task: flags.task,
      });
      if (!result.ok) {
        return fail(err, 1, 'not_found', result.reason);
      }
      if (flags.json) return { code: 0, stdout: JSON.stringify(result) };
      if (result.reading === 'unadjudicated') return { code: 0, stdout: 'unadjudicated' };
      return { code: 0, stdout: result.reading };
    },
  });

  registry.add('report', {
    description: 'Statistics: per class counts, first pass rates, reviewer precision, guard firings',
    handler({ db, config, flags }) {
      const result = report(db, config, {
        taskClass: flags.class,
        since: flags.since,
        guards: !!flags.guards,
        reviewers: !!flags.reviewers,
        loop: !!flags.loop,
      });
      if (flags.json) return { code: 0, stdout: JSON.stringify(result) };

      const lines = [];
      for (const c of result.classes) {
        lines.push(
          `${c.task_class}  n=${c.count}  adjudicated=${c.adjudicated_count}${c.not_routing_grade ? '  (n < 20, not routing grade)' : ''}`
        );
        lines.push(`  first pass: tri ${c.first_pass_rate.tri ?? '-'}  control ${c.first_pass_rate.control ?? '-'}`);
        lines.push(`  mean cost: tri $${c.mean_cost_usd.tri?.toFixed?.(2) ?? '-'}  control $${c.mean_cost_usd.control?.toFixed?.(2) ?? '-'}`);
        lines.push(`  mean elapsed: tri ${c.mean_elapsed_s.tri ?? '-'}s  control ${c.mean_elapsed_s.control ?? '-'}s`);
      }
      if (result.reviewer_precision) {
        lines.push('reviewer precision:');
        for (const r of result.reviewer_precision) {
          lines.push(`  ${r.provider} / ${r.task_class}: ${r.precision != null ? r.precision.toFixed(2) : '-'}`);
        }
      }
      if (result.guard_firings) {
        lines.push('guard firings:');
        for (const g of result.guard_firings) lines.push(`  ${g.reason}: ${g.count}`);
      }
      if (result.loop) {
        lines.push(`loop: proposal spend $${result.loop.proposal_spend_usd.toFixed(2)}`);
        for (const a of result.loop.agents) {
          const actions = Object.entries(a.actions).map(([k, v]) => `${k}=${v}`).join(' ');
          lines.push(`  ${a.agent}: ${a.ticks} tick(s)  $${a.cost_usd.toFixed(2)}  ${actions}`);
        }
      }
      return { code: 0, stdout: lines.join('\n') };
    },
  });

  registry.add('export', {
    description: 'Dump ledger tables to CSV or JSON, one file per table',
    handler({ db, flags, err }) {
      if (!flags.out) return fail(err, 1, 'usage', 'export requires --out <dir>');
      const format = flags.format ?? 'csv';
      if (!['csv', 'json'].includes(format)) {
        return fail(err, 1, 'usage', `--format must be csv or json, got ${format}`);
      }
      let result;
      try {
        result = exportTables(db, { format, table: flags.table, since: flags.since, outDir: flags.out });
      } catch (e) {
        return fail(err, 1, 'usage', e.message);
      }
      if (flags.json) return { code: 0, stdout: JSON.stringify(result) };
      return { code: 0, stdout: result.files.join('\n') };
    },
  });
}
