// Post-run guards (docs/guards.md "Post run (at run:end and ingest)"). Pure
// functions: they read the worktree/out dir and return findings; the caller
// (src/commands/runs.mjs run:end) decides what to do about them, including
// writing escalations via src/limits.mjs.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function toPosix(p) {
  return p.split('\\').join('/');
}

/**
 * Files touched in `worktree` relative to `baseCommit`: the union of
 * `git diff --name-only <base>` (tracked changes) and
 * `git ls-files --others --exclude-standard` (new, untracked files).
 */
export function filesTouched(worktree, baseCommit) {
  const set = new Set();
  const diff = spawnSync('git', ['diff', '--name-only', baseCommit], {
    cwd: worktree,
    shell: false,
    encoding: 'utf8',
  });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: worktree,
    shell: false,
    encoding: 'utf8',
  });
  for (const out of [diff.stdout, untracked.stdout]) {
    for (const line of (out ?? '').split('\n')) {
      const t = line.trim();
      if (t) set.add(toPosix(t));
    }
  }
  return [...set];
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/;

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += GLOB_SPECIAL.test(c) ? `\\${c}` : c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Tiny glob matcher (`**`, `*`, `?`) over forward-slash paths. */
export function matchesAny(path, patterns) {
  const normalized = toPosix(path);
  return patterns.some((p) => globToRegex(p).test(normalized));
}

/**
 * docs/guards.md "Test edit detection": any touched path matching
 * `test_patterns` on a task whose task_class is not `tests` is flagged.
 * Pure predicate - the caller writes the warn escalation.
 */
export function testEditDetection(files, patterns, taskClass) {
  if (taskClass === 'tests') return { touched: false, files: [] };
  const matched = files.filter((f) => matchesAny(f, patterns));
  return { touched: matched.length > 0, files: matched };
}

/**
 * Scan `events.jsonl` for the longest run of consecutive `tool.result`
 * events with `ok === false`. `hit` is true once that streak reaches `n`.
 * `error` is truncated to 200 characters, per docs/guards.md.
 */
export function toolFailureStreak(eventsPath, n) {
  if (!existsSync(eventsPath)) return { hit: false, streak: 0, tool: null, error: null };

  let lines;
  try {
    lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { hit: false, streak: 0, tool: null, error: null };
  }

  let maxStreak = 0;
  let curStreak = 0;
  let bestTool = null;
  let bestError = null;

  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== 'tool.result') continue;
    if (evt.ok === false) {
      curStreak++;
      if (curStreak > maxStreak) {
        maxStreak = curStreak;
        bestTool = evt.tool ?? null;
        bestError = evt.error ?? null;
      }
    } else {
      curStreak = 0;
    }
  }

  return {
    hit: maxStreak >= n,
    streak: maxStreak,
    tool: bestTool,
    error: bestError != null ? String(bestError).slice(0, 200) : null,
  };
}

/**
 * docs/guards.md "Scope marker": a line in out.txt or reasoning.md starting
 * with SCOPE_EXCEEDED or BLOCKED: means the run is `fail` regardless of exit
 * code, with that line copied into halted_reason.
 */
export function scopeMarker(outDir) {
  for (const name of ['out.txt', 'reasoning.md']) {
    const path = join(outDir, name);
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('SCOPE_EXCEEDED') || line.startsWith('BLOCKED:')) {
        return { found: true, line, file: name };
      }
    }
  }
  return { found: false, line: null, file: null };
}

/**
 * docs/state-machine.md "Attempt counting" / docs/guards.md "Post run"
 * (Phase 1a real-batch fix F1): a run is classified `failure_class =
 * 'provider_unavailable'` when its events.jsonl stream ended on a terminal
 * retryable `error` event (docs/adapters.md's normalized event vocabulary -
 * `retryable: true`) with no successful completion anywhere in the file.
 * "No successful completion" is any `session.end` event carrying
 * `exit_code === 0` - if one exists anywhere in the stream, this run is not
 * provider_unavailable regardless of what else happened. "Terminal" means
 * the very last event in the file is that retryable error - real production
 * evidence (12 of 16 runs in the live Phase 1a batch) shows the stream
 * simply stopping there, nothing after it. A missing/empty/unparseable
 * events.jsonl (or one with no retryable error at all) classifies as `null`
 * - never guessed. The caller (run:end, src/commands/runs.mjs) decides
 * whether to apply this at all (only once every other, more specific
 * failure reason - files_touched, a scope marker, no_patch - has already
 * been ruled out) and never writes an escalation here; see
 * src/limits.mjs's `checkAttempts` for where this column is read back.
 */
export function classifyFailureClass(eventsPath) {
  if (!existsSync(eventsPath)) return { failureClass: null };
  let lines;
  try {
    lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { failureClass: null };
  }
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // a truncated write from a killed process, most likely: skip it,
      // same tolerance src/ingest.mjs already applies to this same file.
    }
  }
  if (!events.length) return { failureClass: null };

  const hadSuccessfulCompletion = events.some(
    (e) => e && e.type === 'session.end' && typeof e.exit_code === 'number' && e.exit_code === 0
  );
  if (hadSuccessfulCompletion) return { failureClass: null };

  const last = events[events.length - 1];
  if (last && last.type === 'error' && last.retryable === true) {
    return { failureClass: 'provider_unavailable', statusCode: last.status_code ?? null, message: last.message ?? null };
  }
  return { failureClass: null };
}

/**
 * docs/guards.md "Missing artifacts": for `agent = builder|solo` with exit
 * 0, patch.diff must exist and be non-empty. Returns true when it is
 * missing or empty (the "no_patch" case).
 */
export function missingPatch(outDir) {
  const path = join(outDir, 'patch.diff');
  if (!existsSync(path)) return true;
  try {
    return statSync(path).size === 0;
  } catch {
    return true;
  }
}
