// Review commands (docs/cli.md "Review"): review:brief, verdict, adjudicate,
// triage:note.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildReviewerBrief, storeVerdict, adjudicate, triageNote } from '../review.mjs';
import { getTask } from '../ledger.mjs';
import { checkNotArchived } from '../limits.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

function missing(flags, required) {
  return required.filter((name) => flags[name] === undefined);
}

export function register(registry) {
  registry.add('review:brief', {
    description: 'Write the blind reviewer brief',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['task', 'reviewer']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      let result;
      try {
        result = buildReviewerBrief(db, config, {
          taskId: flags.task,
          reviewer: flags.reviewer,
          issueFile: flags['issue-file'],
        });
      } catch (e) {
        return fail(err, e.code ?? 1, e.reason ?? 'not_found', e.message);
      }
      return { code: 0, stdout: result.path };
    },
  });

  registry.add('verdict', {
    description: 'Validate and store a reviewer verdict',
    handler({ db, config, flags, err }) {
      const need = missing(flags, ['task', 'run', 'reviewer', 'provider', 'model', 'file']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }

      // Codex round, F7 (major): `storeVerdict` (src/review.mjs) already
      // checks archive state "before schema validation and before the
      // blind/challenge gates" per its own doc comment - but this handler
      // used to read and JSON.parse `--file` FIRST, and returned exit
      // 5/verdict_invalid on a bad or missing file before ever calling
      // storeVerdict. So an archived task with a malformed (or simply
      // missing) verdict file got exit 5/verdict_invalid instead of exit
      // 6/archived - the exact inversion of docs/state-machine.md's "archive
      // check happens before any other state check" invariant, and
      // observable proof of it: pointing --file at a bad path is enough to
      // make an archived task look like a schema problem instead of an
      // archive one. Fixed by checking archive state here, before the file
      // is even touched, so the task's own state always wins regardless of
      // what --file contains or whether it exists at all.
      const task = getTask(db, flags.task);
      if (!task) return fail(err, 1, 'not_found', `no such task: ${flags.task}`);
      const notArchived = checkNotArchived(task);
      if (!notArchived.ok) {
        return fail(err, 6, 'archived', notArchived.detail);
      }

      let verdictObj;
      try {
        verdictObj = JSON.parse(readFileSync(flags.file, 'utf8'));
      } catch (e) {
        return fail(err, 5, 'verdict_invalid', `could not read/parse ${flags.file}: ${e.message}`);
      }

      const run = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(flags.run);
      const reviewerEventsPath = run
        ? join(run.out_dir || join(config.runs, flags.task, flags.reviewer), 'events.jsonl')
        : join(config.runs, flags.task, flags.reviewer, 'events.jsonl');

      const result = storeVerdict(db, config, {
        taskId: flags.task,
        runId: flags.run,
        reviewer: flags.reviewer,
        provider: flags.provider,
        model: flags.model,
        verdictObj,
        challenge: !!flags.challenge,
        reviewerEventsPath,
      });

      if (result.code !== 0) {
        const reason = result.reason ?? (result.code === 5 ? 'verdict_invalid' : 'challenge');
        return fail(err, result.code, reason, result.errors.join('; '));
      }
      return { code: 0, stdout: result.verdictId };
    },
  });

  registry.add('adjudicate', {
    description: 'Human adjudication of a verdict',
    handler({ db, flags, err }) {
      const need = missing(flags, ['task', 'real', 'noise']);
      if (need.length) {
        return fail(err, 1, 'usage', `missing required flags: ${need.map((n) => '--' + n).join(', ')}`);
      }
      const real = Number(flags.real);
      const noise = Number(flags.noise);
      if (Number.isNaN(real) || Number.isNaN(noise)) {
        return fail(err, 1, 'usage', `--real and --noise must be numbers`);
      }
      const escaped = flags.escaped !== undefined ? Number(flags.escaped) : undefined;
      const minutes = flags.minutes !== undefined ? Number(flags.minutes) : undefined;

      let result;
      try {
        result = adjudicate(db, {
          taskId: flags.task,
          real,
          noise,
          escaped,
          minutes,
          note: flags.note,
          lesson: flags.lesson,
          appliesTo: flags['applies-to'],
        });
      } catch (e) {
        return fail(err, e.code ?? 1, e.reason ?? 'error', e.message);
      }
      const stdout = result.lesson ? `${result.intervention.id}\nlesson: ${result.lesson.id}` : result.intervention.id;
      return { code: 0, stdout };
    },
  });

  registry.add('triage:note', {
    description: 'Markdown triage comment for a PR',
    handler({ db, config, flags, err }) {
      if (!flags.task) return fail(err, 1, 'usage', 'triage:note requires --task <id>');
      let note;
      try {
        note = triageNote(db, config, flags.task);
      } catch (e) {
        return fail(err, 1, 'not_found', e.message);
      }
      return { code: 0, stdout: note };
    },
  });
}
