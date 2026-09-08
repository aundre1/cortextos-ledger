// Blocker 1 (real defect, owner's machine): launching a review of PR #972
// (492 additions) failed with `spawn ENAMETOOLONG` - the reviewer's brief
// was passed to the harness as a single argv element, and a large brief
// exceeds the Windows command-line limit (`CreateProcess` caps a full
// command line around 32767 characters; the practical limit through
// `child_process.spawn` is lower still). Every adapter now decides, at
// launch, whether the prompt goes through argv or the harness's own stdin
// (`src/adapters/prompt-delivery.mjs`; see docs/adapters.md "Prompt delivery
// (Blocker 1)" for the exact source citations this was verified against).
//
// `task_runs.prompt_delivery` records which channel a given run actually
// used - 'argv' (the prompt was a plain argv element, exactly like every
// adapter did before this task), 'stdin' (the prompt was piped to the
// harness's real stdin instead - never present in any argv this kit built),
// or 'file' (a value this kit's event vocabulary supports for a future
// adapter with no stdin path; nothing here emits it today, since claude,
// codex, and opencode all have a verified stdin path). `null` for every
// pre-existing row and any row inserted directly, bypassing `run:start`/
// `run:launch` (a test, most likely).
//
// Same idempotency pattern as every migration since 002-v01-columns.mjs:
// `ALTER TABLE ... ADD COLUMN` throws if the column already exists, so guard
// it with `PRAGMA table_info` and this file stays safe to import more than
// once.

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export function up(db) {
  if (!hasColumn(db, 'task_runs', 'prompt_delivery')) {
    db.exec('ALTER TABLE task_runs ADD COLUMN prompt_delivery TEXT');
  }
}
