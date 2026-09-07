// doctor command (docs/cli.md "Doctor").

import { doctor } from '../doctor.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

export function register(registry) {
  registry.add('doctor', {
    description: 'Diagnose why a run or task went dark',
    handler({ db, config, flags, err }) {
      if (!flags.task && !flags.run && !flags.all) {
        return fail(err, 1, 'usage', 'doctor requires --task <id>, --run <id>, or --all');
      }
      const result = doctor(db, config, { taskId: flags.task, runId: flags.run, all: !!flags.all });
      if (flags.json) {
        return { code: 0, stdout: JSON.stringify({ findings: result.findings, probableCause: result.probableCause, resolveCommand: result.resolveCommand }) };
      }
      return { code: 0, stdout: result.text };
    },
  });
}
