#!/usr/bin/env bash
# Launch one OpenCode agent detached and record the result to a run
# directory. POSIX equivalent of run-agent.ps1; see that file's header for
# the two load bearing constraints (prompt as a positional argument, --auto
# required) which apply here unchanged.
#
# The preferred path for cortextos-ledger is `cortexctl run:launch`, which
# does everything this script does plus the ledger bookkeeping (attempts,
# spend, escalations) that this script has no idea about. Use this script
# only when driving OpenCode directly, outside the ledger.
#
# Usage:
#   scripts/run-agent.sh --agent <name> --prompt-file <path> --out-dir <path> \
#     --worktree <path> [--model <name>] [--task-id <id>] [--run-id <id>] \
#     [--attach <path>]... [--allow-dirty]
#
# No argument has a personal default; --worktree is mandatory.

set -euo pipefail

agent=""
prompt_file=""
out_dir=""
worktree=""
model=""
task_id=""
run_id=""
allow_dirty=0
attach_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) agent="$2"; shift 2 ;;
    --prompt-file) prompt_file="$2"; shift 2 ;;
    --out-dir) out_dir="$2"; shift 2 ;;
    --worktree) worktree="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --task-id) task_id="$2"; shift 2 ;;
    --run-id) run_id="$2"; shift 2 ;;
    --attach) attach_args+=("-f" "$2"); shift 2 ;;
    --allow-dirty) allow_dirty=1; shift ;;
    *) echo "run-agent.sh: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for required in agent prompt_file out_dir worktree; do
  if [ -z "${!required}" ]; then
    echo "run-agent.sh: --${required//_/-} is required" >&2
    exit 1
  fi
done

# PRE-FLIGHT: never launch an agent into a tree with uncommitted tracked
# changes. The single most destructive failure this kit's guards exist to
# prevent is an agent deleting uncommitted work during an unattended run.
# The agent gets a clean tree or it does not run.
dirty="$(git -C "$worktree" status --porcelain --untracked-files=no 2>/dev/null || true)"
if [ -n "$dirty" ] && [ "$allow_dirty" -ne 1 ]; then
  echo "REFUSING TO LAUNCH: $worktree has uncommitted tracked change(s). Commit or stash first, or pass --allow-dirty if you accept that an agent may destroy them." >&2
  echo "$dirty" | head -n 10 >&2
  exit 2
fi

mkdir -p "$out_dir"
rm -f "$out_dir/done.marker"

model_args=()
if [ -n "$model" ]; then
  model_args=(--model "$model")
fi

# Run the whole detached step in a subshell so CORTEXOS_* only applies to it,
# and so the elapsed timer, exit code, and done.marker are all written
# together regardless of how opencode exits.
(
  cd "$worktree"
  export CORTEXOS_TASK_ID="$task_id"
  export CORTEXOS_RUN_ID="$run_id"
  export CORTEXOS_RUN_DIR="$out_dir"
  prompt="$(cat "$prompt_file")"
  start_ms=$(($(date +%s%N) / 1000000))
  set +e
  opencode run --agent "$agent" --auto "${model_args[@]}" "${attach_args[@]}" "$prompt" >"$out_dir/out.txt" 2>&1
  code=$?
  set -e
  end_ms=$(($(date +%s%N) / 1000000))
  echo "$code" >"$out_dir/exit.txt"
  echo "$((end_ms - start_ms))" >"$out_dir/elapsed_ms.txt"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$out_dir/done.marker"
) < /dev/null > /dev/null 2>&1 &
disown

echo "launched agent=$agent out=$out_dir"
