// Proposal commands (docs/autonomy.md "Proposals"): propose, proposal:review,
// proposal:list, proposal:approve, proposal:reject.

import { existsSync, readFileSync } from 'node:fs';
import { propose, review, listProposals, approve, reject } from '../proposals.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

/** --rationale accepts a literal string or a path to a file (docs/autonomy.md). */
function readMaybeFile(value) {
  if (value === undefined) return undefined;
  if (existsSync(value)) {
    try {
      return readFileSync(value, 'utf8');
    } catch {
      return value;
    }
  }
  return value;
}

export function register(registry) {
  registry.add('propose', {
    description: 'Author a proposal (task, policy, tooling, or experiment)',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['author', 'business', 'kind', 'title', 'rationale', 'impact']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      let row;
      try {
        row = propose(db, config, {
          author: flags.author,
          business: flags.business,
          kind: flags.kind,
          title: flags.title,
          rationale: readMaybeFile(flags.rationale),
          expectedImpact: flags.impact,
          metric: flags.metric,
          usd: flags.usd,
          hours: flags.hours,
          taskClass: flags.class,
        });
      } catch (e) {
        return fail(err, e.code ?? 1, 'usage', e.message);
      }
      return { code: 0, stdout: row.id };
    },
  });

  registry.add('proposal:review', {
    description: 'Support, oppose, or ask to revise a proposal (never your own)',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['id', 'reviewer', 'verdict']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      let result;
      try {
        result = review(db, config, {
          id: flags.id,
          reviewer: flags.reviewer,
          verdict: flags.verdict,
          note: flags.note,
          confidence: flags.confidence,
        });
      } catch (e) {
        return fail(err, e.code ?? 1, e.code === 6 ? 'self_review' : 'usage', e.message);
      }
      return { code: 0, stdout: result.review.id };
    },
  });

  registry.add('proposal:list', {
    description: 'List proposals, optionally filtered by status or business',
    handler({ db, flags }) {
      const rows = listProposals(db, { status: flags.status, business: flags.business });
      if (flags.json) return { code: 0, stdout: JSON.stringify(rows) };
      if (!rows.length) return { code: 0, stdout: 'no proposals' };
      const lines = rows.map(
        (p) => `${p.id}  [${p.status}]  ${p.kind}  ${p.business_id}  ${p.author}  $${p.estimated_usd ?? '-'}  ${p.title}`
      );
      return { code: 0, stdout: lines.join('\n') };
    },
  });

  registry.add('proposal:approve', {
    description: 'Human approval: converts an eligible proposal to a task',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['id', 'by']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      let result;
      try {
        result = approve(db, config, { id: flags.id, by: flags.by, note: flags.note, force: !!flags.force });
      } catch (e) {
        return fail(err, e.code ?? 1, e.code === 6 ? 'task_state' : 'not_found', e.message);
      }
      return { code: 0, stdout: result.task.id };
    },
  });

  registry.add('proposal:reject', {
    description: 'Human refusal of a proposal',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['id', 'by', 'note']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      let result;
      try {
        result = reject(db, config, { id: flags.id, by: flags.by, note: flags.note });
      } catch (e) {
        return fail(err, e.code ?? 1, 'not_found', e.message);
      }
      return { code: 0, stdout: result.proposal.id };
    },
  });
}
