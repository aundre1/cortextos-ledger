// Review commands (docs/cli.md "Review"): review:brief, verdict, adjudicate,
// triage:note.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildReviewerBrief, storeVerdict, adjudicate, triageNote } from '../review.mjs';

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
        return fail(err, 1, 'not_found', e.message);
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
        return fail(err, result.code, result.code === 5 ? 'verdict_invalid' : 'challenge', result.errors.join('; '));
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

      const result = adjudicate(db, {
        taskId: flags.task,
        real,
        noise,
        escaped,
        minutes,
        note: flags.note,
      });
      return { code: 0, stdout: result.intervention.id };
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
