// packet command (docs/cli.md "Packet, measurement, usage" / docs/context-packet.md).

import { join } from 'node:path';
import { buildTaskPacket, buildBoardPacket, writePacket } from '../packet.mjs';

function fail(errFn, code, reason, detail) {
  errFn(`cortexctl: ${reason}: ${detail}`);
  return { code };
}

export function register(registry) {
  registry.add('packet', {
    description: 'Context packet for a task or the board',
    handler({ db, config, flags, err }) {
      const format = flags.format ?? 'both';
      if (!['json', 'md', 'both'].includes(format)) {
        return fail(err, 1, 'usage', `--format must be one of json, md, both, got ${format}`);
      }
      const maxBytes = flags['max-bytes'] !== undefined ? Number(flags['max-bytes']) : undefined;

      let packet;
      let outDir;
      let taskId = null;
      let owner = null;

      if (flags.board) {
        packet = buildBoardPacket(db, config, { owner: flags.owner, maxBytes: maxBytes ?? 12000 });
        outDir = flags.out ?? join(config.runs, 'board');
        owner = 'board';
      } else if (flags.task) {
        taskId = flags.task;
        try {
          packet = buildTaskPacket(db, config, taskId, { maxBytes: maxBytes ?? 8000 });
        } catch (e) {
          return fail(err, 1, 'not_found', e.message);
        }
        outDir = flags.out ?? join(config.runs, taskId);
        owner = JSON.parse(packet.json).task.owner;
      } else {
        return fail(err, 1, 'usage', 'packet requires --task <id> or --board');
      }

      const written = writePacket(db, config, { ...packet, taskId, owner }, outDir);

      if (flags.json) {
        return { code: 0, stdout: JSON.stringify({ files: written.files, truncated: packet.truncated }) };
      }
      const lines = written.files.map((f) => `wrote ${f}`);
      if (format === 'json') lines.push(packet.json);
      if (format === 'md' || format === 'both') lines.push(packet.markdown);
      return { code: 0, stdout: lines.join('\n') };
    },
  });
}
