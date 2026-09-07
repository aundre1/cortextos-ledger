// loop command (docs/autonomy.md "The loop"): the body a CortextOS heartbeat
// or a cron calls, `--once` for every real caller; the repeating form exists
// for a plain cron with no scheduler of its own.

import { tick } from '../loop.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function register(registry) {
  registry.add('loop', {
    description: 'Heartbeat: one bounded autonomous action per tick, default off (config.autonomy.enabled)',
    async handler({ db, config, flags, err }) {
      if (!flags.agent) return fail(err, 1, 'usage', 'loop requires --agent <name>');

      const maxTasks = flags['max-tasks'] !== undefined ? Number(flags['max-tasks']) : Infinity;
      const maxUsd = flags['max-usd'] !== undefined ? Number(flags['max-usd']) : undefined;
      if (flags['max-tasks'] !== undefined && Number.isNaN(maxTasks)) {
        return fail(err, 1, 'usage', `--max-tasks must be a number, got ${flags['max-tasks']}`);
      }
      if (flags['max-usd'] !== undefined && Number.isNaN(maxUsd)) {
        return fail(err, 1, 'usage', `--max-usd must be a number, got ${flags['max-usd']}`);
      }

      let ticks = 0;
      let totalCost = 0;
      let last = null;

      while (ticks < maxTasks) {
        let result;
        try {
          result = await tick(db, config, {
            agent: flags.agent,
            business: flags.business,
            maxUsd,
            adapterOverride: flags.adapter,
          });
        } catch (e) {
          return fail(err, e.code ?? 1, 'autonomy_disabled', e.message);
        }
        ticks++;
        totalCost += result.costUsd ?? 0;
        last = result;

        if (flags.once) break;
        if (maxUsd !== undefined && totalCost >= maxUsd) break;
        if (ticks >= maxTasks) break;
        await sleep(config.autonomy.interval_s * 1000);
      }

      if (flags.json) return { code: 0, stdout: JSON.stringify({ ticks, total_cost_usd: totalCost, last }) };
      const parts = [
        last.action,
        last.taskId ? `task=${last.taskId}` : null,
        last.proposalId ? `proposal=${last.proposalId}` : null,
        `cost=$${(last.costUsd ?? 0).toFixed(4)}`,
      ].filter(Boolean);
      return { code: 0, stdout: parts.join(' ') };
    },
  });
}
