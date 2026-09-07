// ingest command (docs/cli.md "Runs" -> `ingest --events <file> --task <id> --run <id>`).

import { ingest } from '../ingest.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

export function register(registry) {
  registry.add('ingest', {
    description: 'Replay normalized events into the ledger and quota',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['events', 'task', 'run']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }

      let result;
      try {
        result = ingest(db, config, { eventsPath: flags.events, taskId: flags.task, runId: flags.run });
      } catch (e) {
        return fail(err, 1, 'ingest', e.message);
      }

      if (flags.json) return { code: 0, stdout: JSON.stringify(result) };
      return {
        code: 0,
        stdout:
          `ingested ${result.events} events: tokens_in=${result.tokens_in} tokens_out=${result.tokens_out} ` +
          `cost_usd=${result.cost_usd} tool_calls=${result.tool_calls} requests=${result.requests}` +
          (result.budget_escalation_id ? ` (budget escalation ${result.budget_escalation_id})` : ''),
      };
    },
  });
}
