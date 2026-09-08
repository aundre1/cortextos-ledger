#!/usr/bin/env node
// Real smoke test for the published package shape (task E5-3).
//
// Packs the repository exactly as `npm publish` would (never runs
// `npm publish` itself), installs the resulting tarball into a throwaway
// scratch directory the way a consumer would (`npm install <tarball>`,
// never `npm link`), then runs the *installed* cortexctl binary - not the
// repo's own bin/cortexctl.mjs - to prove the package.json "files"
// allowlist ships everything the CLI needs (bin, src, and every relative
// import between them) and that the packed layout still works once it is
// unpacked somewhere else.
//
// Wired into `npm run smoke`. Runs in CI on both ubuntu-latest and
// windows-latest (.github/workflows/ci.yml).
//
// Portable per this repo's coding rules (see "Coding rules" in the wave
// todo, and docs/security.md): no `/tmp` literals (uses node:os tmpdir()),
// no chmod, no shell pipes, spawn with shell: false everywhere, including
// npm itself on Windows (see runNpm's own comment and
// src/adapters/resolve-npm.mjs).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmCommand } from '../src/adapters/resolve-npm.mjs';
import { applyResolvedCommand } from '../src/adapters/resolve-command.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function log(line) {
  process.stdout.write(`[smoke] ${line}\n`);
}

// docs/adapters.md "Windows command resolution": npm itself ships as
// `npm.cmd` on Windows, which Node refuses to spawn with shell:false
// (EINVAL - CVE-2024-27980). Rather than falling back to shell:true (which
// this project's coding rules avoid everywhere else), resolveNpmCommand
// runs the exact npm bundled next to this process's own `node`/`node.exe`
// (node_modules/npm/bin/npm-cli.js) directly with `execPath` - the same npm
// `npm.cmd`'s own shim would have run, with no PATH/shim resolution and no
// shell involved on any platform.
function runNpm(args, cwd) {
  const { cmd, args: finalArgs } = applyResolvedCommand(resolveNpmCommand(), args);
  return execFileSync(cmd, finalArgs, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
}

// Runs the installed cortexctl.mjs directly with `node`, never through an
// OS-specific shim - keeps shell:false everywhere and works identically
// on ubuntu-latest and windows-latest.
function runInstalledCortexctl(binPath, args, cwd) {
  return execFileSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
}

function main() {
  // 1. Pack the repository exactly as `npm publish` would (dry run of the
  // tarball step only - never `npm publish`).
  log('packing tarball with `npm pack`...');
  const packOut = runNpm(['pack', '--json'], REPO_ROOT);
  const [entry] = JSON.parse(packOut);
  const tarballPath = join(REPO_ROOT, entry.filename);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack reported ${entry.filename} but it is not at ${tarballPath}`);
  }
  log(`packed ${entry.filename} (${entry.files.length} files, ${entry.size} bytes)`);

  // 2. Install it into a scratch directory outside the repo, the way a
  // consumer would (`npm install <tarball>`) - never `npm link`.
  const scratch = mkdtempSync(join(tmpdir(), 'cortexctl-smoke-'));
  log(`installing into scratch dir: ${scratch}`);
  try {
    // Fail loudly, right here, if the tarball the rest of E5-3 built ever
    // regresses back to shipping the internal build log or the test suite -
    // scripts/publish-check.mjs checks this too, but a smoke test that
    // silently installed the internal directory would be worse than no
    // smoke test at all. Kept inside the try (after the tarball already
    // exists) so the finally below still deletes it on this failure path -
    // a check that throws before the try/finally starts would leave the
    // packed .tgz behind in the repo root.
    const shippedPaths = entry.files.map((f) => f.path);
    const forbiddenlyShipped = shippedPaths.filter((p) => /^\.claude\//.test(p) || /^test\//.test(p));
    if (forbiddenlyShipped.length) {
      throw new Error(`tarball unexpectedly contains: ${forbiddenlyShipped.join(', ')}`);
    }

    runNpm(['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', tarballPath], scratch);

    const installDir = join(scratch, 'node_modules', 'cortextos-ledger');
    if (!existsSync(installDir)) {
      throw new Error(`expected ${installDir} to exist after npm install, it does not`);
    }

    // Resolve the installed bin entry from the *installed* package.json's
    // own "bin" field, not a hardcoded "bin/cortexctl.mjs" guess - this is
    // what actually proves the shipped file layout is self-consistent.
    const installedPkg = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'));
    const binRel = typeof installedPkg.bin === 'string' ? installedPkg.bin : installedPkg.bin.cortexctl;
    const binPath = join(installDir, binRel);
    if (!existsSync(binPath)) {
      throw new Error(`installed package.json points bin.cortexctl at "${binRel}", but ${binPath} does not exist`);
    }
    log(`resolved installed bin: ${binPath}`);

    // 3. Run the installed `cortexctl init` in a fresh, empty directory.
    // docs/architecture.md's default config creates ./.cortex/ledger.db
    // relative to cwd; src/commands/setup.mjs's `init` handler prints
    // "schema version: <version>" (see .claude/tasks OPEN QUESTION on this
    // wording) after applying every pending migration.
    const projectDir = join(scratch, 'project');
    mkdirSync(projectDir, { recursive: true });
    log('running installed `cortexctl init` in a fresh empty directory...');
    const initOut = runInstalledCortexctl(binPath, ['init'], projectDir);
    if (!/^schema version: \S+/m.test(initOut)) {
      throw new Error(`expected "schema version: <version>" from cortexctl init, got: ${JSON.stringify(initOut)}`);
    }
    const dbPath = join(projectDir, '.cortex', 'ledger.db');
    if (!existsSync(dbPath)) {
      throw new Error(`cortexctl init did not create ${dbPath}`);
    }
    log(`OK: init exited 0, printed "${initOut.trim()}", created ${dbPath}`);

    // 4. `cortexctl --help` - no command name registers as a boolean flag,
    // so this exercises the same "no command at all" path bin/cortexctl.mjs
    // takes, which test/cli.test.mjs asserts prints the usage banner and
    // the full command list and exits 0.
    log('running installed `cortexctl --help`...');
    const helpOut = runInstalledCortexctl(binPath, ['--help'], projectDir);
    if (!/cortexctl <command> \[--flags\]/.test(helpOut)) {
      throw new Error(`cortexctl --help did not print the usage banner, got: ${JSON.stringify(helpOut)}`);
    }
    if (!/task:new/.test(helpOut) || !/purge/.test(helpOut)) {
      throw new Error('cortexctl --help output is missing expected commands (task:new, purge)');
    }
    log('OK: --help printed the usage banner and full command list');

    log('SMOKE PASSED');
  } finally {
    // 5. Clean up: scratch install dir and the tarball `npm pack` left in
    // the repo root, so a smoke run never leaves a stray *.tgz behind for
    // git to notice.
    rmSync(scratch, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
}

main();
