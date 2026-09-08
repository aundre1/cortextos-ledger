// Windows command resolution (docs/adapters.md "Windows command
// resolution", this wave's Windows spawn-resolution fix).
//
// The problem: every adapter and `gh`/`npm` call in this kit spawns a bare
// command name (`claude`, `codex`, `opencode`, `gh`, `npm`) with
// `shell: false`. On POSIX that is exactly right - `spawn`'s own PATH search
// finds the real executable. On Windows, a harness installed via `npm i -g`
// exists on PATH only as `<name>.cmd`/`<name>.ps1` (npm's own shim
// convention); Node's `spawn` with `shell: false` performs PATHEXT-aware
// resolution but that resolves `.exe`/`.com`/`.bat` - never `.cmd` - and,
// since the CVE-2024-27980 fix, spawning a `.cmd`/`.bat` directly without
// `shell: true` throws `EINVAL` rather than silently doing the wrong thing.
// `resolveCommand` below finds the *real* target behind a `.cmd` shim
// (either a bundled `.exe` or a `node + .js` launcher - the two shapes npm's
// own shim generator produces) so the eventual `spawn(cmd, args, { shell:
// false })` call always has something it can actually exec, and only falls
// back to invoking `cmd.exe` itself (with correctly escaped arguments) when
// neither shape can be parsed.
//
// Every filesystem/platform/env input is a parameter with a real default, so
// tests can inject `platform: 'win32'` (and a scratch PATH) on any host,
// including this Linux workspace - see test/resolve-command.test.mjs.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Cross-spawn's cmd.exe argument escaping (docs/security.md "Windows
 * command-line fallback"), ported here rather than adding a dependency:
 * escape a literal `"` as `\"` (doubling any backslashes that immediately
 * precede it, and any that would otherwise escape the closing quote), wrap
 * the whole argument in quotes, then escape cmd.exe's own metacharacters
 * `()%!^"<>&|` with a leading `^` so cmd.exe's command-line parser (which
 * runs *after* Windows' own argv-to-command-line quoting) does not act on
 * them itself.
 */
export function escapeCmdArg(value) {
  let arg = String(value);
  // A run of backslashes immediately followed by a `"`: escape every
  // backslash in the run (doubled) and the quote itself (`\"`).
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  // A run of backslashes at the very end of the string: doubled, so they
  // don't escape the closing quote this function is about to add.
  arg = arg.replace(/(\\*)$/, '$1$1');
  arg = `"${arg}"`;
  arg = arg.replace(/([()%!^"<>&|])/g, '^$1');
  return arg;
}

function existsSafe(p) {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function splitPath(env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  return raw.split(';').map((s) => s.trim()).filter(Boolean);
}

// npm's own shim generator (cmd-shim) emits exactly two shapes on Windows:
//
//   direct-exe: "%dp0%\node_modules\<pkgpath>\<file>.exe"   %*
//   node-launcher: "%_prog%"  "%dp0%\node_modules\<pkgpath>\<file>.js" %*
//     (older shims call "%dp0%\node.exe" directly instead of via %_prog%;
//     both end in the same node_modules\...\*.js" %* tail, which is all this
//     regex needs to match)
//
// Matching only the node_modules\...\*.exe" / *.js" tail (not the exact
// prefix) is deliberate: it is robust to either launcher-prefix spelling and
// to the shim's own comment/blank-line boilerplate around it.
const DIRECT_EXE_RE = /%dp0%\\(node_modules\\[^"\r\n]+?\.exe)"\s+%\*/i;
const NODE_LAUNCHER_RE = /%dp0%\\(node_modules\\[^"\r\n]+?\.js)"\s+%\*/i;

function joinRelative(baseDir, relWindowsPath) {
  return path.join(baseDir, ...relWindowsPath.split('\\'));
}

/**
 * Parse an npm-generated `.cmd`/`.bat` shim at `shimPath` and resolve it to
 * its real target. Never throws. Always returns a usable resolution: the
 * cmd.exe fallback (rule e) when the shim can't be read, doesn't match
 * either known shape, or its resolved target does not exist on disk.
 */
function resolveCmdShim(shimPath, { env, execPath, readFile }) {
  let text = null;
  try {
    text = readFile(shimPath);
  } catch {
    text = null;
  }

  if (text) {
    const shimDir = path.dirname(shimPath);

    const exeMatch = text.match(DIRECT_EXE_RE);
    if (exeMatch) {
      const target = joinRelative(shimDir, exeMatch[1]);
      if (existsSafe(target)) {
        return { cmd: target, prefixArgs: [], resolvedFrom: 'npm shim -> exe' };
      }
    }

    const jsMatch = text.match(NODE_LAUNCHER_RE);
    if (jsMatch) {
      const target = joinRelative(shimDir, jsMatch[1]);
      if (existsSafe(target)) {
        return { cmd: execPath, prefixArgs: [target], resolvedFrom: 'npm shim -> node + js' };
      }
    }
  }

  // Rule e: unparseable (or the parsed target is missing) - fall back to
  // cmd.exe itself. The shim path is escaped exactly like every other
  // argument the caller appends (escapeArgs: true tells the caller to do the
  // same for its own args).
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  return {
    cmd: comspec,
    prefixArgs: ['/d', '/s', '/c', escapeCmdArg(shimPath)],
    resolvedFrom: 'cmd.exe fallback',
    escapeArgs: true,
  };
}

/**
 * resolveCommand(name, opts) -> { cmd, prefixArgs, resolvedFrom, escapeArgs? }
 *
 * `resolvedFrom` is a short human string describing how `cmd` was found
 * (`'posix'`, `'given'`, `'exe on PATH'`, `'com on PATH'`, `'npm shim ->
 * exe'`, `'npm shim -> node + js'`, `'cmd.exe fallback'`), or `null` when
 * nothing on PATH matched at all (rule f) - the caller then spawns `name`
 * itself and gets the platform's own ENOENT.
 *
 * See the module comment above for why this exists and docs/adapters.md
 * "Windows command resolution" for the full rule list.
 */
export function resolveCommand(
  name,
  { platform = process.platform, env = process.env, execPath = process.execPath, readFile = (p) => readFileSync(p, 'utf8') } = {}
) {
  if (platform !== 'win32') {
    return { cmd: name, prefixArgs: [], resolvedFrom: 'posix' };
  }

  // Rule b: a path (contains a separator) or an already-explicit extension.
  // A `.cmd`/`.bat` given explicitly still goes through the shim parser
  // (rule e is its last resort); `.exe`/`.com`, or anything containing a
  // path separator, is used exactly as given.
  if (/\.(cmd|bat)$/i.test(name)) {
    return resolveCmdShim(name, { env, execPath, readFile });
  }
  if (/[\\/]/.test(name) || /\.(exe|com)$/i.test(name)) {
    return { cmd: name, prefixArgs: [], resolvedFrom: 'given' };
  }

  const dirs = splitPath(env);

  // Rule c: every PATH entry's <name>.exe then <name>.com, first hit wins -
  // an .exe anywhere on PATH beats a .cmd shim earlier on PATH, because this
  // whole pass runs before rule d ever looks at a .cmd.
  for (const dir of dirs) {
    const exe = path.join(dir, `${name}.exe`);
    if (existsSafe(exe)) return { cmd: exe, prefixArgs: [], resolvedFrom: 'exe on PATH' };
    const com = path.join(dir, `${name}.com`);
    if (existsSafe(com)) return { cmd: com, prefixArgs: [], resolvedFrom: 'com on PATH' };
  }

  // Rule d: the first <name>.cmd on PATH, parsed as an npm shim (falling
  // through to the cmd.exe fallback, rule e, if it can't be parsed).
  for (const dir of dirs) {
    const cmdPath = path.join(dir, `${name}.cmd`);
    if (existsSafe(cmdPath)) {
      return resolveCmdShim(cmdPath, { env, execPath, readFile });
    }
  }

  // Rule f: nothing found anywhere on PATH.
  return { cmd: name, prefixArgs: [], resolvedFrom: null };
}

/**
 * Fold a resolveCommand() result and the caller's own intended args into the
 * final { cmd, args } to hand `spawn`/`spawnSync`: `resolution.prefixArgs`
 * goes first, then `args`, escaped with escapeCmdArg() when
 * `resolution.escapeArgs` is set (the cmd.exe fallback, rule e - every other
 * resolution shape passes `args` through untouched).
 */
export function applyResolvedCommand(resolution, args) {
  const tail = resolution.escapeArgs ? args.map(escapeCmdArg) : args;
  return { cmd: resolution.cmd, args: [...resolution.prefixArgs, ...tail] };
}

/**
 * The precedence this kit documents everywhere command resolution matters
 * (docs/adapters.md "Windows command resolution", docs/architecture.md
 * `config.tools`): an explicit `cmd` (an adapter-level test/config override,
 * e.g. `config.adapters.<name>.cmd`) wins outright; failing that, a
 * `config.tools.<name>` array skips resolveCommand entirely (`cmd =
 * override[0]`, `prefixArgs = override.slice(1)`); failing that,
 * `resolveCommand(defaultName, ...)` runs the platform-aware search above.
 */
export function resolveConfiguredCommand(defaultName, { cmd, toolOverride, platform, env, execPath, readFile } = {}) {
  if (cmd) return { cmd, prefixArgs: [], resolvedFrom: 'override' };
  if (Array.isArray(toolOverride) && toolOverride.length) {
    return { cmd: toolOverride[0], prefixArgs: toolOverride.slice(1), resolvedFrom: 'config.tools' };
  }
  return resolveCommand(defaultName, { platform, env, execPath, readFile });
}
