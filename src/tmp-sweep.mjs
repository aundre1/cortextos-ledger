// Sweep <runs>/.tmp/ of stale entries (blind review NF3, medium).
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
// Fixed two ways: (a) this sweep, called at the start of `init` and at the
// start of every `task:new` (src/commands/setup.mjs, src/commands/tasks.mjs)
// so a stale leftover cannot survive more than one of either command; (b) a
// `finally` around the capture itself in task:new so the *normal* failure
// path (gh failing, or an exception during redaction/hashing) also cleans
// up immediately rather than relying on the next sweep.

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes, per this fix's own requirement.

/**
 * Delete every entry directly under `<runsDir>/.tmp/` whose mtime is more
 * than `maxAgeMs` old. Returns the array of deleted entry names (empty when
 * `.tmp/` does not exist at all, which is the common case - most tasks are
 * never a PR capture, so most `runs` roots never get a `.tmp/` directory).
 *
 * Uses `fs.statSync(...).mtimeMs` (not birthtime, which several POSIX
 * filesystems do not track at all) so the age check behaves identically on
 * Windows and POSIX - this fix's own "Windows-safe" requirement.
 *
 * Every filesystem call tolerates ENOENT as "already gone" rather than
 * throwing: `.tmp/` itself, or one entry inside it, can legitimately
 * disappear between the `readdirSync` listing and the `statSync`/
 * `unlinkSync` that follows for it - a concurrent `task:new` finishing and
 * cleaning up its own temp file after (or during) this same sweep is not a
 * bug in either caller, so this function must not treat that race as one
 * (this fix's own "ignore ENOENT races" requirement). Any other error
 * (permissions, disk error) still propagates - only a vanished path is
 * expected and swallowed.
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

  const deleted = [];
  for (const name of entries) {
    const path = join(tmpDir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (now - stat.mtimeMs <= maxAgeMs) continue;
    try {
      unlinkSync(path);
      deleted.push(name);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return deleted;
}
