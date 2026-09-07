// Lesson commands (docs/autonomy.md "Lessons"): lesson:add, lesson:list, lesson:retire.

import { add, list, retire } from '../lessons.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

export function register(registry) {
  registry.add('lesson:add', {
    description: 'Add a lesson, injected into packets/briefs for its task class and actor',
    handler({ db, flags, err }) {
      const need = missing(flags, ['source', 'lesson']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      let row;
      try {
        row = add(db, {
          source: flags.source,
          lesson: flags.lesson,
          taskId: flags.task,
          taskClass: flags.class,
          appliesTo: flags['applies-to'],
          evidence: flags.evidence,
          confidence: flags.confidence,
        });
      } catch (e) {
        return fail(err, e.code ?? 1, 'usage', e.message);
      }
      return { code: 0, stdout: row.id };
    },
  });

  registry.add('lesson:list', {
    description: 'List active/retired lessons, optionally filtered',
    handler({ db, flags }) {
      const rows = list(db, { taskClass: flags.class, appliesTo: flags['applies-to'], status: flags.status });
      if (flags.json) return { code: 0, stdout: JSON.stringify(rows) };
      if (!rows.length) return { code: 0, stdout: 'no lessons' };
      const lines = rows.map(
        (l) => `${l.id}  [${l.status}]  ${l.task_class ?? '*'}/${l.applies_to}  conf=${l.confidence}  ${l.lesson}`
      );
      return { code: 0, stdout: lines.join('\n') };
    },
  });

  registry.add('lesson:retire', {
    description: 'Retire a lesson so it stops being injected',
    handler({ db, flags, err }) {
      const need = missing(flags, ['id', 'reason']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      let row;
      try {
        row = retire(db, { id: flags.id, reason: flags.reason });
      } catch (e) {
        return fail(err, e.code ?? 1, 'not_found', e.message);
      }
      return { code: 0, stdout: row.id };
    },
  });
}
