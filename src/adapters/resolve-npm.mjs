// npm-specific command resolution, shared by scripts/publish-check.mjs and
// scripts/smoke-pack.mjs (docs/adapters.md "Windows command resolution").
//
// npm is a special case worth its own strategy rather than routing through
// resolveCommand('npm', ...) and its PATH/shim search: every Node
// distribution ships its own npm CLI as a plain `.js` file right next to
// `node`/`node.exe` itself, at `<node install dir>/node_modules/npm/bin/
// npm-cli.js` - the same file `npm.cmd`'s own shim on Windows points at (see
// resolve-command.mjs's node-launcher shape). Running that file directly
// with `process.execPath` sidesteps PATH/PATHEXT/`.cmd` shim resolution
// entirely: it is the exact npm this exact `node` would run, on every
// platform, with no risk of picking up some *other* npm earlier on PATH.
// `resolveCommand('npm', ...)` remains the fallback for the (rare) case
// where a Node installation does not bundle npm at all.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCommand } from './resolve-command.mjs';

/**
 * resolveNpmCommand({ execPath, platform, env, readFile }) -> { cmd, args:
 * prefixArgs, resolvedFrom }. `resolvedFrom` is `'bundled npm-cli.js'` when
 * the strategy above found npm next to `execPath`, or whatever
 * `resolveCommand('npm', ...)` reports otherwise (`'posix'`, `'exe on
 * PATH'`, `'npm shim -> node + js'` - npm.cmd's own shim is exactly this
 * shape - `'cmd.exe fallback'`, or `null`).
 */
export function resolveNpmCommand({ execPath = process.execPath, platform, env, readFile } = {}) {
  const bundled = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) {
    return { cmd: execPath, prefixArgs: [bundled], resolvedFrom: 'bundled npm-cli.js' };
  }
  // Fall back to full PATH/shim resolution - pass the result straight
  // through (escapeArgs included, on the rare cmd.exe-fallback path) so
  // callers can always use applyResolvedCommand() uniformly.
  return resolveCommand('npm', { platform, env, execPath, readFile });
}
