// retro command (docs/autonomy.md "Retro").

import { join } from 'node:path';
import { retro } from '../retro.mjs';

export function register(registry) {
  registry.add('retro', {
    description: 'Read the ledger for patterns, draft lessons and proposals, write retro.md/retro.json',
    handler({ db, config, flags }) {
      const outDir = flags.out ?? join(config.runs, 'retro', flags.business ?? 'all');
      const result = retro(db, config, { since: flags.since, business: flags.business, outDir });

      if (flags.json) {
        return {
          code: 0,
          stdout: JSON.stringify({
            findings: result.findings,
            drafted_lessons: result.drafted_lessons,
            drafted_proposals: result.drafted_proposals,
            files: result.files,
          }),
        };
      }
      const lines = result.files.map((f) => `wrote ${f}`);
      lines.push(result.markdown);
      return { code: 0, stdout: lines.join('\n') };
    },
  });
}
