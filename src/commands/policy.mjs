// Policy commands (docs/autonomy.md "Policy proposals"): policy:apply,
// policy:revert, policy:list.

import { readFileSync, existsSync } from 'node:fs';
import { apply, revert, listPolicy } from '../policy.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

/** --overrides accepts an inline JSON object or a path to a JSON file. */
function readOverrides(value, err) {
  if (value === undefined) return { ok: true, value: {} };
  let text = value;
  if (existsSync(value)) {
    try {
      text = readFileSync(value, 'utf8');
    } catch (e) {
      return { ok: false, error: `cannot read --overrides file: ${e.message}` };
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: `--overrides is not valid JSON: ${e.message}` };
  }
}

export function register(registry) {
  registry.add('policy:apply', {
    description: 'Apply a policy proposal as config.agents overrides for its task class (needs >= 20 adjudicated runs)',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['id', 'by']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const overrides = readOverrides(flags.overrides, err);
      if (!overrides.ok) return fail(err, 1, 'usage', overrides.error);

      let result;
      try {
        result = apply(db, config, { proposalId: flags.id, by: flags.by, overrides: overrides.value });
      } catch (e) {
        return fail(err, e.code ?? 1, e.code === 6 ? 'insufficient_runs' : 'usage', e.message);
      }
      return { code: 0, stdout: result.policy.id };
    },
  });

  registry.add('policy:revert', {
    description: 'Deactivate a routing policy',
    handler({ db, flags, err }) {
      if (!flags.id) return fail(err, 1, 'usage', 'policy:revert requires --id <po>');
      let row;
      try {
        row = revert(db, { id: flags.id });
      } catch (e) {
        return fail(err, e.code ?? 1, 'not_found', e.message);
      }
      return { code: 0, stdout: row.id };
    },
  });

  registry.add('policy:list', {
    description: 'List routing policies, optionally filtered by class or active state',
    handler({ db, flags }) {
      const active = flags.active !== undefined ? (flags.active === 'false' ? 0 : 1) : undefined;
      const rows = listPolicy(db, { taskClass: flags.class, active });
      if (flags.json) return { code: 0, stdout: JSON.stringify(rows) };
      if (!rows.length) return { code: 0, stdout: 'no policies' };
      const lines = rows.map((p) => `${p.id}  ${p.task_class}  active=${p.active}  applied_by=${p.applied_by}  ${p.agent_overrides_json}`);
      return { code: 0, stdout: lines.join('\n') };
    },
  });
}
