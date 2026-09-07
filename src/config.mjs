// Config resolution: --config, then CORTEX_LEDGER_CONFIG, then
// ./cortex-ledger.json, then built in defaults (docs/architecture.md
// "Configuration"). Paths are made absolute relative to the config file's
// directory, or the cwd when only built in defaults apply.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

// Exactly the JSON block in docs/architecture.md.
export const DEFAULTS = {
  db: './.cortex/ledger.db',
  runs: './.cortex/runs',
  limits: {
    builder_attempts_max: 3,
    challenge_cycles_max: 1,
    wallclock_s: 5400,
    spend_usd: 5.0,
    files_touched_max: 10,
    stall_s: 900,
  },
  test_patterns: ['**/*.test.*', '**/*_test.*', '**/__tests__/**', '**/tests/**', '**/spec/**'],
  providers: {
    google: { windows: [{ kind: 'day', limit_requests: 20 }] },
    'opencode-go': {
      windows: [
        { kind: '5h', limit_usd: 12 },
        { kind: 'week', limit_usd: 30 },
        { kind: 'month', limit_usd: 60 },
      ],
    },
    nvidia: { windows: [{ kind: 'minute', limit_requests: 40 }], public_only: true },
  },
};

const LIMIT_KEYS = [
  'builder_attempts_max',
  'challenge_cycles_max',
  'wallclock_s',
  'spend_usd',
  'files_touched_max',
  'stall_s',
];

function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`config not found: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`config is not valid JSON: ${path}: ${e.message}`);
  }
}

function mergeConfig(defaults, override) {
  const merged = { ...defaults, ...override };
  // `limits` is deep merged one level so a partial override does not drop
  // the other default limits. Everything else (db, runs, test_patterns,
  // providers) is replaced wholesale when the override supplies it, since
  // the docs do not describe a per key merge for those.
  merged.limits = { ...defaults.limits, ...(override.limits || {}) };
  return merged;
}

function validateLimits(limits) {
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`limits.${key} must be a positive number, got ${JSON.stringify(value)}`);
    }
  }
}

/**
 * Resolve configuration.
 * @param {object} [opts]
 * @param {string} [opts.configPath] value of --config, if given
 * @param {string} [opts.dbOverride] value of --db, if given
 * @param {string} [opts.cwd] working directory (defaults to process.cwd())
 */
export function loadConfig({ configPath, dbOverride, cwd = process.cwd() } = {}) {
  let configFilePath = null;
  let raw = {};

  if (configPath) {
    configFilePath = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
    raw = readJsonFile(configFilePath);
  } else if (process.env.CORTEX_LEDGER_CONFIG) {
    const envPath = process.env.CORTEX_LEDGER_CONFIG;
    configFilePath = isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
    raw = readJsonFile(configFilePath);
  } else {
    const defaultPath = resolve(cwd, 'cortex-ledger.json');
    if (existsSync(defaultPath)) {
      configFilePath = defaultPath;
      raw = readJsonFile(configFilePath);
    }
  }

  const merged = mergeConfig(DEFAULTS, raw);
  const baseDir = configFilePath ? dirname(configFilePath) : cwd;

  merged.db = isAbsolute(merged.db) ? merged.db : resolve(baseDir, merged.db);
  merged.runs = isAbsolute(merged.runs) ? merged.runs : resolve(baseDir, merged.runs);
  merged.configPath = configFilePath;

  if (dbOverride) {
    merged.db = isAbsolute(dbOverride) ? dbOverride : resolve(cwd, dbOverride);
  }

  validateLimits(merged.limits);
  return merged;
}
