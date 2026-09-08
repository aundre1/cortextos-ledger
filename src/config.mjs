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
  // docs/autonomy.md "Goals contract": path to the private goals file. Never
  // shipped populated - examples/cortex-goals.example.json is the template.
  goals: './cortex-goals.json',
  // docs/adapters.md "Concurrency note" (review round 1, F4): when true,
  // `run:start --agent <a>` for an agent whose adapter resolves to
  // `opencode` refuses (exit 6, reason opencode_serial) while any task_runs
  // row anywhere in the ledger is still `running` with `adapter = 'opencode'`
  // - the fallback for an OpenCode version where the per agent
  // `XDG_DATA_HOME` isolation (run:launch, `dataHome`) is found not to hold.
  // Off by default: the isolation is the primary fix, this is the backstop.
  opencode_serial: false,
  // docs/autonomy.md "The autonomy dial", verbatim.
  autonomy: {
    enabled: false,
    propose: true,
    review_proposals: true,
    auto_approve_below_usd: 0,
    auto_approve_kinds: ['task'],
    min_reviews: 1,
    max_open_proposals_per_agent: 3,
    proposal_ttl_days: 14,
    lessons_per_packet: 5,
    default_arm: 'tri',
    default_owner: 'founder',
    interval_s: 900,
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
  // `limits` and `autonomy` are deep merged one level so a partial override
  // does not drop the other default limits/dial settings. Everything else
  // (db, runs, test_patterns, providers) is replaced wholesale when the
  // override supplies it, since the docs do not describe a per key merge
  // for those.
  merged.limits = { ...defaults.limits, ...(override.limits || {}) };
  merged.autonomy = { ...defaults.autonomy, ...(override.autonomy || {}) };
  return merged;
}

// docs/adapters.md "Windows command resolution": per-tool argv-array
// overrides that skip resolveCommand entirely (cmd = override[0], prefixArgs
// = override.slice(1)) - e.g. `"tools": { "gh": ["C:/tools/gh.exe"] }`. Keyed
// by tool name (`gh`, `claude`, `codex`, `opencode`, `npm`, ...); not
// restricted to a fixed allowlist here since an operator's own PATH quirks
// are exactly what this escape hatch exists for.
function validateTools(tools) {
  if (tools === undefined) return;
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) {
    throw new Error(`tools must be an object, got ${JSON.stringify(tools)}`);
  }
  for (const [name, override] of Object.entries(tools)) {
    if (!Array.isArray(override) || override.length === 0 || !override.every((v) => typeof v === 'string' && v.length > 0)) {
      throw new Error(`tools.${name} must be a non-empty array of non-empty strings, got ${JSON.stringify(override)}`);
    }
  }
}

function validateLimits(limits) {
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`limits.${key} must be a positive number, got ${JSON.stringify(value)}`);
    }
  }
}

const AUTONOMY_BOOLEAN_KEYS = ['enabled', 'propose', 'review_proposals'];
const AUTONOMY_NONNEGATIVE_NUMBER_KEYS = [
  'auto_approve_below_usd',
  'min_reviews',
  'max_open_proposals_per_agent',
  'proposal_ttl_days',
  'lessons_per_packet',
  'interval_s',
];

function validateAutonomy(autonomy) {
  for (const key of AUTONOMY_BOOLEAN_KEYS) {
    if (typeof autonomy[key] !== 'boolean') {
      throw new Error(`autonomy.${key} must be a boolean, got ${JSON.stringify(autonomy[key])}`);
    }
  }
  for (const key of AUTONOMY_NONNEGATIVE_NUMBER_KEYS) {
    const value = autonomy[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`autonomy.${key} must be a non-negative number, got ${JSON.stringify(value)}`);
    }
  }
  if (!Array.isArray(autonomy.auto_approve_kinds) || !autonomy.auto_approve_kinds.every((k) => typeof k === 'string')) {
    throw new Error('autonomy.auto_approve_kinds must be an array of strings');
  }
  if (typeof autonomy.default_arm !== 'string' || !['tri', 'control'].includes(autonomy.default_arm)) {
    throw new Error(`autonomy.default_arm must be 'tri' or 'control', got ${JSON.stringify(autonomy.default_arm)}`);
  }
  if (typeof autonomy.default_owner !== 'string' || autonomy.default_owner.length === 0) {
    throw new Error('autonomy.default_owner must be a non-empty string');
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
  merged.goals = isAbsolute(merged.goals) ? merged.goals : resolve(baseDir, merged.goals);
  merged.configPath = configFilePath;

  if (dbOverride) {
    merged.db = isAbsolute(dbOverride) ? dbOverride : resolve(cwd, dbOverride);
  }

  validateLimits(merged.limits);
  validateAutonomy(merged.autonomy);
  validateTools(merged.tools);
  return merged;
}
