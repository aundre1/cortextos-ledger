#!/usr/bin/env node
// cortexctl - CLI entry point. Dispatch only: parses argv, loads config,
// opens the db, and dispatches through a command registry that
// src/commands/*.mjs populate via register(registry). This is the only
// file in the kit that calls process.exit (project coding rule).

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';

// node:sqlite emits an ExperimentalWarning on stderr; every non zero exit
// must print exactly one line there (docs/state-machine.md), so keep stderr
// clean of Node's own noise the same way the original cortexctl.mjs did.
process.removeAllListeners('warning');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const COMMANDS_DIR = join(ROOT, 'src', 'commands');

// Every flag docs/cli.md documents as bare (no `<value>` placeholder), across
// every command in the kit, not only this wave's. A boolean flag never
// consumes the following token as its value - this matters because flags
// may appear anywhere, including immediately before a positional argument
// (e.g. `cortexctl --json task:show <id>`), where the naive "next token
// doesn't start with --" heuristic would otherwise swallow the command name
// or id as this flag's value.
const BOOLEAN_FLAGS = new Set([
  'json',
  'quiet',
  'dry-run',
  'public',
  'allow-dirty',
  'strict',
  'no-preflight',
  'detach',
  'sync',
  'challenge',
  'no-tests',
  'retry-authorized',
  'confirm',
  'board',
  'all',
  'guards',
  'reviewers',
  'once',
  'force',
  'loop',
]);

/** argv -> { command, args, flags }. --flag value and --boolean flags may appear anywhere. */
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

function createRegistry() {
  const commands = new Map();
  return {
    add(name, entry) {
      commands.set(name, entry);
    },
    get(name) {
      return commands.get(name);
    },
    list() {
      return [...commands.entries()]
        .map(([name, entry]) => ({ name, description: entry.description ?? '' }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
  };
}

/** Import every src/commands/*.mjs file (filename order) and call register(registry). */
async function loadCommands(registry) {
  let files = [];
  try {
    files = readdirSync(COMMANDS_DIR)
      .filter((f) => f.endsWith('.mjs'))
      .sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    const mod = await import(pathToFileURL(join(COMMANDS_DIR, file)).href);
    if (typeof mod.register === 'function') mod.register(registry);
  }
}

function printHelp(registry) {
  process.stdout.write('cortexctl <command> [--flags]\n\n');
  for (const { name, description } of registry.list()) {
    process.stdout.write(`  ${name.padEnd(18)} ${description}\n`);
  }
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  const registry = createRegistry();
  await loadCommands(registry);

  if (!command || command === 'help') {
    printHelp(registry);
    process.exit(0);
  }

  const entry = registry.get(command);
  if (!entry) {
    process.stderr.write(`cortexctl: usage: unknown command: ${command}\n`);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig({ configPath: flags.config, dbOverride: flags.db });
  } catch (e) {
    process.stderr.write(`cortexctl: config: ${e.message}\n`);
    process.exit(1);
  }

  let db;
  try {
    db = openDb(config.db);
  } catch (e) {
    process.stderr.write(`cortexctl: db: ${e.message}\n`);
    process.exit(1);
  }

  const out = (line) => {
    if (!flags.quiet) process.stdout.write(line + '\n');
  };
  const err = (line) => {
    process.stderr.write(line + '\n');
  };

  let result;
  try {
    result = await entry.handler({ db, config, args, flags, out, err });
  } catch (e) {
    err(`cortexctl: error: ${e.message}`);
    try {
      db.close();
    } catch {
      // already closed or unusable; nothing more to do before exiting.
    }
    process.exit(1);
  }

  if (result && typeof result.stdout === 'string' && result.stdout.length > 0) {
    process.stdout.write(result.stdout + '\n');
  }

  try {
    db.close();
  } catch {
    // ignore
  }
  process.exit(result?.code ?? 0);
}

main();
