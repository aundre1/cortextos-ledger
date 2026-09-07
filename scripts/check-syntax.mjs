#!/usr/bin/env node
// lint: walks src, bin, plugins, scripts, test and runs `node --check` on
// every .mjs/.js file (shell false - no globbing through a shell). Exits
// non zero if any file fails to parse. This is a syntax check, not a style
// linter: the kit has zero dependencies and no build step, so there is no
// ESLint here.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIRS = ['src', 'bin', 'plugins', 'scripts', 'test'];
const EXTS = new Set(['.mjs', '.js']);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXTS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const files = [];
  for (const d of DIRS) walk(join(ROOT, d), files);
  files.sort();

  let failures = 0;
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      process.stdout.write(`ok   ${file}\n`);
    } catch (e) {
      failures++;
      process.stdout.write(`FAIL ${file}\n`);
      const stderr = e.stderr ? e.stderr.toString() : e.message;
      process.stderr.write(stderr + '\n');
    }
  }

  process.stdout.write(`\n${files.length} file(s) checked, ${failures} failure(s)\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
