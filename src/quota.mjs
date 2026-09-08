// Provider quota window arithmetic (docs/ledger.md "provider_quota" and
// "Windows roll"). Exported for src/commands/setup.mjs here, and for the
// guards and ingest code that later executors add in src/guards/*.mjs and
// src/ingest.mjs.
//
// Window semantics:
//   minute, 5h  - rolling from first use: when a window has expired, the
//                 next roll starts a brand new window anchored at `now`
//                 (matching subscription style rolling windows, not a fixed
//                 clock schedule).
//   day         - calendar UTC day, window_started_at is always 00:00:00Z.
//   week        - calendar UTC week, Monday 00:00:00Z start (ISO 8601 weeks).
//   month       - calendar UTC month, first-of-month 00:00:00Z start.

import { newId } from './db.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid time value: ${value}`);
  return ms;
}

function windowLengthMs(kind, startMs) {
  switch (kind) {
    case 'minute':
      return MINUTE_MS;
    case '5h':
      return 5 * HOUR_MS;
    case 'day':
      return DAY_MS;
    case 'week':
      return 7 * DAY_MS;
    case 'month': {
      const d = new Date(startMs);
      const nextMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      return nextMonthStart - startMs;
    }
    default:
      // Unknown window kind: fall back to the most conservative (shortest
      // sensible) rolling length rather than guessing a calendar alignment.
      return 5 * HOUR_MS;
  }
}

/** Start of the window that contains `nowMs`, for the given window kind. */
function currentWindowStartMs(kind, nowMs) {
  const d = new Date(nowMs);
  switch (kind) {
    case 'minute':
    case '5h':
      return nowMs;
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case 'week': {
      const dayOfWeek = d.getUTCDay(); // 0 Sun .. 6 Sat
      const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek; // 1 Mon .. 7 Sun
      const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return utcMidnight - (isoDay - 1) * DAY_MS;
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    default:
      return nowMs;
  }
}

/**
 * Roll every provider_quota window forward: any window whose start plus its
 * length is at or before `now` gets its usage reset to zero and its
 * window_started_at advanced to the start of the window containing `now`.
 * Returns the number of rows rolled. Idempotent: rolling twice at the same
 * `now` only resets a window once.
 */
export function rollQuota(db, now = new Date()) {
  const nowMs = toMs(now);
  const nowIsoStr = new Date(nowMs).toISOString();
  const rows = db.prepare('SELECT id, window_kind, window_started_at FROM provider_quota').all();
  const update = db.prepare(
    'UPDATE provider_quota SET used_requests = 0, used_usd = 0, window_started_at = ?, updated_at = ? WHERE id = ?'
  );
  let rolled = 0;
  for (const row of rows) {
    const startMs = Date.parse(row.window_started_at);
    if (Number.isNaN(startMs)) continue;
    const endMs = startMs + windowLengthMs(row.window_kind, startMs);
    if (nowMs >= endMs) {
      const newStartMs = currentWindowStartMs(row.window_kind, nowMs);
      update.run(new Date(newStartMs).toISOString(), nowIsoStr, row.id);
      rolled++;
    }
  }
  return rolled;
}

/** ISO timestamp of when a provider_quota row's current window ends. */
export function windowEndsAt(row) {
  const startMs = Date.parse(row.window_started_at);
  if (Number.isNaN(startMs)) return null;
  return new Date(startMs + windowLengthMs(row.window_kind, startMs)).toISOString();
}

/** Find one provider_quota row by its (provider, model, window_kind) key. */
export function findQuotaRow(db, { provider, model = null, windowKind }) {
  return db
    .prepare('SELECT * FROM provider_quota WHERE provider = ? AND window_kind = ? AND model IS ?')
    .get(provider, windowKind, model);
}

// ---------------------------------------------------------------------------
// Config-derived ceilings (docs/architecture.md "Configuration" providers.*
// .windows[], docs/guards.md "Provider quota"). Without this, a ceiling that
// only exists in the config file is never enforced: `checkQuota` (src/
// limits.mjs) only ever reads `provider_quota` rows, and those rows were
// previously created only by `quota:set`. `syncConfigQuota` makes the
// config the fallback source of truth for a window's *limits* by writing
// them into provider_quota (so the existing row-based check, roll and tick
// machinery keeps working unchanged), while a `quota:set` row for the same
// (provider, model, window_kind) always wins and is never touched again by
// config.
// ---------------------------------------------------------------------------

/**
 * Seed or refresh provider_quota rows from `config.providers[*].windows` so
 * a ceiling declared only in the config file is real without ever running
 * `quota:set`.
 *
 * Precedence (docs contract for this fix): a row already set by
 * `quota:set` (`source = 'manual'`) always wins and is left completely
 * alone here, forever, for that (provider, model, window_kind) key - config
 * can never silently overwrite an operator's override.
 *
 * For every other window the config declares:
 *   - no existing row -> insert one (`source = 'config'`, zero usage, window
 *     starting now - the same "a brand new window starts now" convention
 *     `upsertQuota` already uses for a fresh `quota:set` row);
 *   - an existing non-manual row (`source` 'config' from an earlier sync, or
 *     'ingest') -> its `limit_requests`/`limit_usd` are refreshed to the
 *     current config value on every call, so editing the config file takes
 *     effect immediately rather than only at the first `init` (the staleness
 *     a one-time "seed at init" design would otherwise reintroduce);
 *     `used_requests`/`used_usd`/`window_started_at` are left untouched, so
 *     usage accumulated within the current window survives the refresh.
 *
 * A config window with no `kind` is skipped (malformed, not this
 * function's job to validate). Called from `checkQuota` (src/limits.mjs),
 * `quota:show`, and `quota:tick`'s command handler so the config-derived
 * ceiling is enforced and visible everywhere provider_quota is read.
 */
export function syncConfigQuota(db, config, now = new Date()) {
  const providers = config?.providers ?? {};
  const nowIsoStr = new Date(toMs(now)).toISOString();

  for (const [provider, providerConfig] of Object.entries(providers)) {
    const windows = Array.isArray(providerConfig?.windows) ? providerConfig.windows : [];
    for (const w of windows) {
      const windowKind = w?.kind;
      if (!windowKind) continue;
      const model = w.model ?? null;
      const limitRequests = w.limit_requests ?? null;
      const limitUsd = w.limit_usd ?? null;

      const existing = findQuotaRow(db, { provider, model, windowKind });
      if (existing?.source === 'manual') continue; // quota:set's override always wins

      if (existing) {
        db.prepare(
          'UPDATE provider_quota SET limit_requests = ?, limit_usd = ?, source = ?, updated_at = ? WHERE id = ?'
        ).run(limitRequests, limitUsd, 'config', nowIsoStr, existing.id);
      } else {
        db.prepare(
          `INSERT INTO provider_quota
             (id, provider, model, window_kind, window_started_at, limit_requests, limit_usd,
              used_requests, used_usd, source, updated_at)
           VALUES (?,?,?,?,?,?,?,0,0,'config',?)`
        ).run(newId('q'), provider, model, windowKind, nowIsoStr, limitRequests, limitUsd, nowIsoStr);
      }
    }
  }
}

/**
 * Manual usage increment (`cortexctl quota:tick`). Rolls windows forward
 * first, then adds `requests`/`usd` to every window row for `provider` that
 * applies to `model` - the model specific row when one exists, and any
 * provider wide row (model IS NULL), since a provider wide ceiling counts
 * usage from every model under it. There is no --window flag in
 * docs/cli.md's quota:tick entry, so every matching window is ticked at
 * once rather than a single named one.
 */
export function tickQuota(db, { provider, model = null, requests = 0, usd = 0, now = new Date() } = {}) {
  rollQuota(db, now);
  const nowIsoStr = new Date(toMs(now)).toISOString();
  const rows = db
    .prepare('SELECT id FROM provider_quota WHERE provider = ? AND (model IS NULL OR model = ?)')
    .all(provider, model);
  const update = db.prepare(
    'UPDATE provider_quota SET used_requests = used_requests + ?, used_usd = used_usd + ?, updated_at = ? WHERE id = ?'
  );
  for (const row of rows) {
    update.run(requests, usd, nowIsoStr, row.id);
  }
  return rows.length;
}
