// Secrets scan (docs/guards.md "Secrets in tree", docs/security.md "Secrets
// scan"). Reports path and line only - the matched value is never returned,
// logged, or stored anywhere. Skips .git/node_modules/.cortex, files over
// maxBytes, and binaries (a NUL byte in the first 8 KB).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// docs/guards.md gives most of these as bare prefixes (`ghp_`, `sk-ant-`,
// `github_pat_`, `xox[abp]-`, `nvapi-`) with no quantifier, since it is
// describing a scan target, not a regex - a quantifier is added here so
// each pattern actually matches a plausible token (`ghp_` + GitHub's real
// 36-character suffix, a specific charset with a minimum length elsewhere)
// rather than a bare `\S{4,}`, which - being satisfied by any four
// non-whitespace characters - would match this very array's own source
// (a regex literal like `/ghp_\S{4,}/` is itself four-plus non-whitespace
// characters after `ghp_`) the moment this file, or anything else that
// quotes these patterns as code, was itself scanned (scripts/publish-check.mjs
// does exactly that).
export const PATTERNS = [
  { label: 'private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY/ },
  { label: 'openai_key', regex: /sk-[A-Za-z0-9]{20,}/ },
  { label: 'anthropic_key', regex: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { label: 'github_pat_classic', regex: /ghp_[A-Za-z0-9]{36}/ },
  { label: 'github_pat_fine', regex: /github_pat_[A-Za-z0-9_]{20,}/ },
  { label: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { label: 'slack_token', regex: /xox[abp]-[A-Za-z0-9-]+/ },
  { label: 'google_api_key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { label: 'google_oauth_token', regex: /ya29\.[A-Za-z0-9_-]+/ },
  { label: 'nvidia_api_key', regex: /nvapi-[A-Za-z0-9_-]{10,}/ },
];

// Filename-only checks: `.env`, `.env.*`, `*.pem`, `*.key`, `credentials.json`.
export const SECRET_FILENAMES = ['.env', '.env.*', '*.pem', '*.key', 'credentials.json'];

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_SKIP_DIRS = ['.git', 'node_modules', '.cortex'];
const BINARY_SNIFF_BYTES = 8192;

function filenameGlobToRegex(glob) {
  let re = '';
  for (const c of glob) {
    if (c === '*') re += '.*';
    else if (/[.+^${}()|[\]\\]/.test(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function matchesFilename(name, patterns) {
  return patterns.some((p) => filenameGlobToRegex(p).test(name));
}

function looksBinary(buf) {
  const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function toPosix(p) {
  return p.split('\\').join('/');
}

function walk(dir, skipDirs, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      walk(join(dir, entry.name), skipDirs, out);
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * Scan `dir` for secret-looking file names and file contents. Returns
 * [{ path, line, pattern }] with forward-slash paths relative to `dir`.
 * `line` is `null` for a filename-only finding. Never includes the matched
 * text itself.
 */
export function scan(dir, { maxBytes = DEFAULT_MAX_BYTES, skipDirs = DEFAULT_SKIP_DIRS } = {}) {
  const findings = [];
  const files = [];
  walk(dir, skipDirs, files);

  for (const fullPath of files) {
    const relPath = toPosix(relative(dir, fullPath));
    const baseName = relPath.split('/').pop();

    if (matchesFilename(baseName, SECRET_FILENAMES)) {
      findings.push({ path: relPath, line: null, pattern: 'secret_filename' });
    }

    let size;
    try {
      size = statSync(fullPath).size;
    } catch {
      continue;
    }
    if (size === 0 || size > maxBytes) continue;

    let buf;
    try {
      buf = readFileSync(fullPath);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { label, regex } of PATTERNS) {
        if (regex.test(lines[i])) {
          findings.push({ path: relPath, line: i + 1, pattern: label });
        }
      }
    }
  }

  return findings;
}
