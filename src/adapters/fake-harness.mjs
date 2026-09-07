#!/usr/bin/env node
// Standalone child process for the fake adapter's default (non `--sync`)
// `run:launch` path (review round 1, F2): reads the exact same fixture
// format src/adapters/fake.mjs's own in-process run() reads - JSON from the
// path named by `CORTEX_FAKE_FIXTURE` in this process's env, or an empty
// fixture with neither - writes `fixture.files` into the current working
// directory (the task's worktree, since launchDetached spawns this with
// `cwd: task.worktree`), prints each `fixture.events` entry as one
// normalized JSON line to stdout (fake.mjs's createStreamParser() passes
// these straight through into events.jsonl), and exits with
// `fixture.exitCode`. Never imported - invoked only as a child process by
// fake.mjs's buildArgv().

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

function loadFixture() {
  const path = process.env.CORTEX_FAKE_FIXTURE;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function writeFileEnsuringDir(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const fixture = loadFixture();
const cwd = process.cwd();

if (fixture.files) {
  for (const [relativePath, content] of Object.entries(fixture.files)) {
    const dest = isAbsolute(relativePath) ? relativePath : join(cwd, relativePath);
    writeFileEnsuringDir(dest, content);
  }
}

for (const event of fixture.events ?? []) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// `stdout_json` (docs/autonomy.md: the loop's propose/review steps read the
// model's JSON output this way) and plain `out` text both belong on stdout
// here too, same as the in-process run()'s out.txt - they are not events
// (JSON.parse of a non-event-shaped line is skipped by the createStreamParser
// above), just text the runner will redact and tee into out.txt.
if (fixture.stdout_json !== undefined) {
  process.stdout.write(`${JSON.stringify(fixture.stdout_json)}\n`);
} else if (fixture.out) {
  process.stdout.write(fixture.out);
}

process.exitCode = fixture.exitCode ?? 0;
