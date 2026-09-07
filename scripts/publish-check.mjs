#!/usr/bin/env node
// Refuses to let anything private leave the repository (docs/security.md,
// docs/measurement.md). Run before publishing an export or opening a public
// pull request: `node scripts/publish-check.mjs`.
//
// Checks every path from `git diff --cached --name-only` (what is about to be
// committed) plus `git ls-files` (everything already tracked, since a
// publish step packages the tree as it stands, not only the staged delta):
//
//   - path is under .cortex/ or orgs/
//   - basename is events.jsonl or reasoning.md
//   - basename matches .env, .env.*, *.pem, *.key, or credentials.json
//   - file content matches a secrets pattern from docs/guards.md (the
//     canonical list in src/guards/secrets-scan.mjs), or contains a literal
//     personal path (C:\Users\, /Users/, D:\CoWork) - except this script's
//     own source and anything under test/, which are exempt from the
//     content scan only (see CONTENT_SCAN_EXEMPT_* below)
//
// It also guards the published *package* itself (task E5-3, on top of the
// git-tracked-tree checks above):
//
//   - package.json must declare a "files" allowlist. With none, `npm pack`
//     ships the entire working tree minus .gitignore/.npmignore - the
//     failure mode this task exists to close.
//   - whatever `npm pack --dry-run` would actually put in the tarball must
//     not include anything under .claude/, anything under the forbidden
//     dirs/basenames above, or any file whose content matches a secrets
//     pattern - independent of what the "files" allowlist currently says,
//     so a future edit to package.json can't silently reopen this.
//
// On any hit: prints the path and, for a content match, the line number
// only, never the matched value. Exits 2. With no hits, prints one OK line
// and exits 0.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync as readFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS as SCAN_PATTERNS } from '../src/guards/secrets-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

const FORBIDDEN_DIRS = [/(^|\/)\.cortex\//, /(^|\/)orgs\//];
const FORBIDDEN_BASENAMES = new Set(['events.jsonl', 'reasoning.md']);

// Paths whose *content* is exempt from the secret/personal-path scan below,
// because their entire job is to define or exercise these very patterns,
// not to leak a real one:
//   - this script's own source, which must literally contain the personal
//     path substrings it matches against (`C:\Users\`, `/Users/`,
//     `D:\CoWork`) as part of writing the regexes themselves;
//   - `test/`, whose fixtures deliberately embed realistic-looking (fake)
//     secret-shaped strings to prove the matchers work - flagging those
//     would make it impossible to ever commit a passing test suite.
// Forbidden-directory and forbidden-basename checks still apply everywhere,
// content scanning included - only the pattern-content scan is skipped here.
const CONTENT_SCAN_EXEMPT_PATHS = new Set(['scripts/publish-check.mjs']);
const CONTENT_SCAN_EXEMPT_DIR_PREFIXES = ['test/'];

function contentScanExempt(gitPath) {
  if (CONTENT_SCAN_EXEMPT_PATHS.has(gitPath)) return true;
  return CONTENT_SCAN_EXEMPT_DIR_PREFIXES.some((prefix) => gitPath.startsWith(prefix));
}

function isForbiddenSecretFile(basename) {
  if (basename === '.env') return true;
  if (basename.startsWith('.env.')) return true;
  if (basename.endsWith('.pem')) return true;
  if (basename.endsWith('.key')) return true;
  if (basename === 'credentials.json') return true;
  return false;
}

// The same canonical, quantified list docs/guards.md's secrets scan table
// describes, shared with src/guards/secrets-scan.mjs and
// src/adapters/credential-boundary.mjs (one definition, per the wave's
// cross-module seams) rather than a second, separately maintained copy. A
// bare, unquantified prefix here (as this file used to define locally)
// would self-match the moment any other file in the repo so much as
// documents or defines that same prefix - docs/guards.md's own prose,
// this kit's own pattern-definition source files, and plugins/opencode's
// standalone copy all mention `ghp_`, `sk-ant-`, etc. by name without
// following them with a real token.
const SECRET_PATTERNS = SCAN_PATTERNS.map((p) => ({ name: p.label, re: p.regex }));

// Personal absolute paths that must never appear in a committed file
// (docs/security.md "Public versus private in this repository").
const PERSONAL_PATH_PATTERNS = [
  { name: 'windows-users-path', re: /C:\\Users\\/ },
  { name: 'unix-users-path', re: /\/Users\// },
  { name: 'personal-work-path', re: /D:\\CoWork/ },
];

const CONTENT_PATTERNS = [...SECRET_PATTERNS, ...PERSONAL_PATH_PATTERNS];

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // A repo with no commits yet, or another git failure: treat as no paths
    // rather than crashing the check.
    return '';
  }
}

function collectPaths() {
  const staged = git(['diff', '--cached', '--name-only']);
  const tracked = git(['ls-files']);
  const set = new Set();
  for (const line of staged.split('\n')) {
    const p = line.trim();
    if (p) set.add(p);
  }
  for (const line of tracked.split('\n')) {
    const p = line.trim();
    if (p) set.add(p);
  }
  return [...set];
}

function basenameOf(gitPath) {
  const idx = gitPath.lastIndexOf('/');
  return idx === -1 ? gitPath : gitPath.slice(idx + 1);
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function checkPath(gitPath, findings) {
  const basename = basenameOf(gitPath);

  for (const re of FORBIDDEN_DIRS) {
    if (re.test(gitPath)) {
      findings.push(`BLOCKED path ${gitPath} (under a directory that must never be committed)`);
      return findings; // structural match is enough; skip content scan
    }
  }
  if (FORBIDDEN_BASENAMES.has(basename)) {
    findings.push(`BLOCKED path ${gitPath} (files named ${basename} must never be committed)`);
    return findings;
  }
  if (isForbiddenSecretFile(basename)) {
    findings.push(`BLOCKED path ${gitPath} (matches a secret file name pattern)`);
    return findings;
  }

  if (!existsSyncSafe(gitPath)) {
    // Deleted-but-listed path: nothing left to scan for content.
    return findings;
  }

  if (contentScanExempt(gitPath)) return findings;

  let buf;
  try {
    buf = readFile(gitPath);
  } catch {
    return findings; // unreadable (permissions, race): nothing more we can do
  }
  if (looksBinary(buf)) return findings;

  const text = buf.toString('utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of CONTENT_PATTERNS) {
      if (pattern.re.test(line)) {
        findings.push(`BLOCKED secret ${gitPath}:${i + 1} (matches ${pattern.name})`);
      }
    }
  }
  return findings;
}

function existsSyncSafe(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

// package.json must declare a "files" allowlist (task E5-3). With none,
// `npm pack` falls back to shipping the whole working tree minus
// .gitignore/.npmignore - exactly the failure mode this check exists to
// close, so a non-array or empty allowlist counts as "none" too.
function checkFilesField(findings) {
  let pkg;
  try {
    pkg = JSON.parse(readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  } catch (e) {
    findings.push(`BLOCKED package.json (could not read/parse: ${e.message})`);
    return;
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    findings.push('BLOCKED package.json (no "files" allowlist - npm pack would ship the whole working tree)');
  }
}

// What `npm pack` would *actually* put in the tarball, independent of the
// "files" allowlist's current contents - a future edit to package.json
// could add a path back in without anyone touching this script. Applies
// the same forbidden-dir/basename/secret-content rules checkPath applies
// to the git tree, plus .claude/ specifically (never git-tracked, but
// nothing stops a future "files" entry from reaching into it by mistake).
const PACK_FORBIDDEN_DIRS = [...FORBIDDEN_DIRS, /(^|\/)\.claude\//];

function checkPackedPath(pkgPath, findings) {
  const basename = basenameOf(pkgPath);

  for (const re of PACK_FORBIDDEN_DIRS) {
    if (re.test(pkgPath)) {
      findings.push(`BLOCKED packaged path ${pkgPath} (npm pack would ship a directory that must never be published)`);
      return;
    }
  }
  if (FORBIDDEN_BASENAMES.has(basename) || isForbiddenSecretFile(basename)) {
    findings.push(`BLOCKED packaged path ${pkgPath} (npm pack would ship a file matching a forbidden name pattern)`);
    return;
  }

  // Content scan: same exemptions as the git-tree scan above (this
  // script's own source, and test/ fixtures that deliberately embed
  // fake-secret-shaped strings to prove the matchers work) - though
  // neither is expected to actually be packaged once package.json's
  // "files" allowlist is correct.
  if (contentScanExempt(pkgPath)) return;
  if (!existsSyncSafe(pkgPath)) return;

  let buf;
  try {
    buf = readFile(pkgPath);
  } catch {
    return;
  }
  if (looksBinary(buf)) return;

  const lines = buf.toString('utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of CONTENT_PATTERNS) {
      if (pattern.re.test(lines[i])) {
        findings.push(`BLOCKED packaged secret ${pkgPath}:${i + 1} (matches ${pattern.name})`);
      }
    }
  }
}

// Runs `npm pack --dry-run --json` and checks every path it reports.
// Never runs `npm publish`. A pack failure (e.g. no package.json at all)
// is reported as a finding rather than crashing this script uncommunicatively.
function checkPackedTarball(findings) {
  let out;
  try {
    out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    findings.push(`BLOCKED npm pack --dry-run (failed to run: ${e.message})`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    findings.push(`BLOCKED npm pack --dry-run (could not parse --json output: ${e.message})`);
    return;
  }
  const [entry] = parsed;
  const files = entry?.files ?? [];
  for (const f of files) {
    checkPackedPath(f.path, findings);
  }
}

function main() {
  const paths = collectPaths();
  const findings = [];
  for (const p of paths) {
    checkPath(p, findings);
  }
  checkFilesField(findings);
  checkPackedTarball(findings);

  if (findings.length > 0) {
    for (const line of findings) process.stdout.write(line + '\n');
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    `OK ${paths.length} tracked or staged path(s) checked, package.json has a "files" allowlist, ` +
      `and npm pack --dry-run ships nothing forbidden\n`,
  );
  process.exitCode = 0;
}

main();
