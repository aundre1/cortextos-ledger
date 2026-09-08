// Sweep <runs>/.tmp/ of stale entries (blind review NF3, medium; NF5, minor).
//
// task:new's PR capture (src/commands/tasks.mjs) streams `gh pr diff`'s
// output into <runs>/.tmp/<taskId>.pr.diff.raw before task:new's ledger
// transaction ever commits - a deliberate design (docs/review-protocol.md
// "PR triage mode", review round 2 F4/F6) so a `gh` failure or a rolled
// back transaction never leaves a half-populated task directory behind.
// That design has its own blind spot: if `cortexctl` itself is SIGKILLed
// while that raw diff is still streaming (or between the redact pass
// finishing and the rename into <runs>/<taskId>/pr.diff), nothing else ever
// revisits `.tmp/` - the unredacted diff sits there permanently, in
// contradiction of docs/security.md's "What the ledger stores" (diffs are
// never meant to be at rest unredacted) and "Never committed" table.
//
// Fixed three ways: (a) this sweep, called at the start of `init` and at the
// start of every `task:new` (src/commands/setup.mjs, src/commands/tasks.mjs)
// so a stale leftover cannot survive more than one of either command; (b) a
// `finally` around the capture itself in task:new so the *normal* failure
// path (gh failing, or an exception during redaction/hashing) also cleans
// up immediately rather than relying on the next sweep; (c) NF5 - a pid
// sidecar next to the raw file so age alone is never the only signal a
// capture has actually stalled.
//
// NF5 (minor, round 5): (a) and (b) alone decide purely on `mtime` age. A
// capture that is genuinely still running past `maxAgeMs` (a very large
// diff over a slow link, say) - or any process whose clock jumps forward -
// looks identical to an abandoned one to a *concurrent* `init`/`task:new`'s
// sweep, which would then unlink a file the first process is still
// midway through writing. Fixed with a pid sidecar
// (`<name>.pid`, containing the writing process's `process.pid` as plain
// text): task:new writes it the moment it decides the raw file's name,
// before anything ever opens that file for writing, and removes it in the
// same `finally` that removes the raw file itself (see
// `writePidSidecar`/`removePidSidecar` below, used by
// src/commands/tasks.mjs). The sweep here now skips any entry whose
// sidecar names a still-alive pid - regardless of how stale its mtime looks
// - and, when it does delete a stale entry, deletes its sidecar with it. An
// entry with no sidecar at all keeps the plain mtime rule from (a) (older
// data on disk from before this fix, or any future caller that never wrote
// one). A future-dated mtime (a backward-then-forward clock jump) is always
// left alone, sidecar or not - it cannot be proven stale.

import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes, per this fix's own requirement.
const PID_SIDECAR_SUFFIX = '.pid';

/** The sidecar path for a given raw temp file path (not necessarily existing). */
export function pidSidecarPath(rawPath) {
  return `${rawPath}${PID_SIDECAR_SUFFIX}`;
}

/**
 * Write a pid sidecar next to `rawPath` recording `pid` (default: this
 * process's own `process.pid`) as plain text. Called by
 * src/commands/tasks.mjs the moment it decides the raw temp diff's path,
 * before anything opens that path for writing, so the sidecar's existence
 * can never lag behind the file it guards.
 */
export function writePidSidecar(rawPath, pid = process.pid) {
  writeFileSync(pidSidecarPath(rawPath), String(pid));
}

/**
 * Remove `rawPath`'s pid sidecar, if any. ENOENT (never written, or already
 * removed) is not an error - callers use this from a `finally` that must
 * tolerate running more than once, or running when no sidecar was ever
 * created.
 */
export function removePidSidecar(rawPath) {
  try {
    unlinkSync(pidSidecarPath(rawPath));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** Parse a sidecar file's content as a positive integer pid, or null if missing/unreadable/malformed. */
function readPidSidecar(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether `pid` names a process that is still alive, using the standard
 * `kill(pid, 0)` liveness probe (sends no signal, only checks - works
 * identically on Windows via libuv's OpenProcess-based implementation of
 * signal 0). `ESRCH` (no such process) is the only definitive "dead"
 * answer; `EPERM` (a real process exists but this user cannot signal it -
 * e.g. it re-execed as a different user) means it is alive, per this fix's
 * own instruction. Any other, unexpected error is also treated as "alive" -
 * the failure mode of wrongly skipping a truly-dead entry for one more
 * sweep cycle is far cheaper than the failure mode this fix exists to
 * prevent (deleting a file a live process is still writing).
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Delete stale entries directly under `<runsDir>/.tmp/`. Returns the array
 * of deleted names (raw files and the sidecars deleted alongside them;
 * empty when `.tmp/` does not exist at all, the common case since most
 * tasks are never a PR capture).
 *
 * Per-entry decision (NF5): a `.pid` sidecar file is never evaluated in its
 * own right - it is only ever considered, and only ever deleted, alongside
 * the raw entry it names (`<name>.pid` for `<name>`), whichever one of them
 * this loop is currently looking at.
 *   - mtime in the future (relative to `now`): always left alone, sidecar
 *     or not - a clock jump means staleness cannot be proven.
 *   - a sidecar exists and names a still-alive pid: left alone regardless
 *     of mtime age - a live capture in progress, not an abandoned one.
 *   - otherwise (no sidecar, or a sidecar naming a dead/unreadable pid):
 *     the plain mtime rule from the original NF3 fix - delete once older
 *     than `maxAgeMs`, taking its sidecar with it if one exists.
 *
 * A `.pid` sidecar left orphaned (its raw file already gone, e.g. removed
 * by a normal `finally` cleanup that raced this same sweep) is swept by the
 * same mtime rule once stale, so a sidecar can never accumulate forever
 * either.
 *
 * Every filesystem call tolerates ENOENT as "already gone" rather than
 * throwing - `.tmp/` itself, or one entry inside it, can legitimately
 * disappear between the initial `readdirSync` listing and the
 * `statSync`/`unlinkSync` that follows for it, which is not a bug in either
 * concurrent caller. Any other error (permissions, disk error) still
 * propagates.
 */
export function sweepTmpDir(runsDir, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const tmpDir = join(runsDir, '.tmp');
  let entries;
  try {
    entries = readdirSync(tmpDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const nameSet = new Set(entries);

  function tryUnlink(path, deleted, name) {
    try {
      unlinkSync(path);
      deleted.push(name);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  function statOrNull(path) {
    try {
      return statSync(path);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  const deleted = [];
  for (const name of entries) {
    if (name.endsWith(PID_SIDECAR_SUFFIX)) {
      // Handled alongside its primary entry below when that entry is
      // visited (whether the pair survives or is deleted together); an
      // orphan sidecar (no matching primary entry at all) falls through to
      // its own plain mtime check here instead.
      const primaryName = name.slice(0, -PID_SIDECAR_SUFFIX.length);
      if (nameSet.has(primaryName)) continue;

      const path = join(tmpDir, name);
      const stat = statOrNull(path);
      if (!stat) continue;
      const age = now - stat.mtimeMs;
      if (age < 0 || age <= maxAgeMs) continue; // future mtime, or not stale yet
      tryUnlink(path, deleted, name);
      continue;
    }

    const path = join(tmpDir, name);
    const stat = statOrNull(path);
    if (!stat) continue;
    const age = now - stat.mtimeMs;
    if (age < 0) continue; // future mtime: never provably stale, leave it alone

    const sidecarName = `${name}${PID_SIDECAR_SUFFIX}`;
    const hasSidecar = nameSet.has(sidecarName);
    if (hasSidecar) {
      const pid = readPidSidecar(join(tmpDir, sidecarName));
      if (pid != null && isPidAlive(pid)) continue; // still being written - leave both alone
    }

    if (age <= maxAgeMs) continue; // not stale yet (no sidecar, or a dead one - same rule either way)

    tryUnlink(path, deleted, name);
    if (hasSidecar) tryUnlink(join(tmpDir, sidecarName), deleted, sidecarName);
  }
  return deleted;
}
