# Example: running one issue, control then tri

This walks one GitHub issue through both arms of a measured task: the control
arm first (so it is not contaminated by review findings), then the tri arm,
then `compare`. Commands are `cortexctl` flags from `docs/cli.md`; nothing
here is invented. Both PowerShell and bash forms are given at each step; pick
one and stay in it for the whole run, since captured shell variables differ.

Assumes `cortex-ledger.json` exists in the repo root (or `--db`/`--config` are
passed explicitly) and `cortexctl init` has already been run once.

## 1. Open the control task

PowerShell:

```powershell
$controlTask = (cortexctl task:new --repo owner/name --title "Fix flaky retry in uploader" `
  --class ci-hardening --arm control --issue 208).Trim()
```

bash:

```bash
control_task=$(cortexctl task:new --repo owner/name --title "Fix flaky retry in uploader" \
  --class ci-hardening --arm control --issue 208)
```

## 2. Give the control arm its own worktree

A dedicated worktree keeps the two arms from ever touching the same files on
disk, which matters because they run from the same base commit.

PowerShell:

```powershell
git worktree add ..\uploader-control -b cortex/208-control
cortexctl task:show $controlTask   # confirm worktree, base_commit, branch as expected
```

bash:

```bash
git worktree add ../uploader-control -b cortex/208-control
cortexctl task:show "$control_task"
```

## 3. Preflight, then start the run

Preflight runs automatically inside `run:start`, but calling it directly first
is a fast way to catch a dirty worktree or a secrets hit before you commit to
a run id.

PowerShell:

```powershell
cortexctl preflight --worktree ..\uploader-control --provider opencode-go
$controlRun = (cortexctl run:launch --task $controlTask --agent solo --prompt-file .\brief.txt).Trim()
```

bash:

```bash
cortexctl preflight --worktree ../uploader-control --provider opencode-go
control_run=$(cortexctl run:launch --task "$control_task" --agent solo --prompt-file ./brief.txt)
```

## 4. Wait for it, then end and close it

```powershell
cortexctl watch --run $controlRun
cortexctl run:end --run $controlRun --exit 0 --cost 0.42 --summary "fixed retry backoff"
cortexctl test --task $controlTask --run $controlRun --suite "node --test" --status pass
cortexctl task:close --task $controlTask --outcome first_pass
```

```bash
cortexctl watch --run "$control_run"
cortexctl run:end --run "$control_run" --exit 0 --cost 0.42 --summary "fixed retry backoff"
cortexctl test --task "$control_task" --run "$control_run" --suite "node --test" --status pass
cortexctl task:close --task "$control_task" --outcome first_pass
```

## 5. Open the tri task, linked to the control task

```powershell
$triTask = (cortexctl task:new --repo owner/name --title "Fix flaky retry in uploader" `
  --class ci-hardening --arm tri --issue 208 --sibling $controlTask).Trim()
git worktree add ..\uploader-tri -b cortex/208-tri
```

```bash
tri_task=$(cortexctl task:new --repo owner/name --title "Fix flaky retry in uploader" \
  --class ci-hardening --arm tri --issue 208 --sibling "$control_task")
git worktree add ../uploader-tri -b cortex/208-tri
```

## 6. Run the builder, then the blind reviewer

```powershell
$builderRun = (cortexctl run:launch --task $triTask --agent builder --prompt-file .\brief.txt).Trim()
cortexctl watch --run $builderRun
cortexctl run:end --run $builderRun --exit 0 --cost 0.51 --summary "fixed retry backoff, same approach"

cortexctl review:brief --task $triTask --reviewer reviewer
$reviewRun = (cortexctl run:launch --task $triTask --agent reviewer --prompt-file .\reviewer\brief.md).Trim()
cortexctl watch --run $reviewRun
cortexctl verdict --task $triTask --run $reviewRun --reviewer reviewer `
  --provider google --model gemini-3.8-flash --file .\reviewer\verdict.json
```

```bash
builder_run=$(cortexctl run:launch --task "$tri_task" --agent builder --prompt-file ./brief.txt)
cortexctl watch --run "$builder_run"
cortexctl run:end --run "$builder_run" --exit 0 --cost 0.51 --summary "fixed retry backoff, same approach"

cortexctl review:brief --task "$tri_task" --reviewer reviewer
review_run=$(cortexctl run:launch --task "$tri_task" --agent reviewer --prompt-file ./reviewer/brief.md)
cortexctl watch --run "$review_run"
cortexctl verdict --task "$tri_task" --run "$review_run" --reviewer reviewer \
  --provider google --model gemini-3.8-flash --file ./reviewer/verdict.json
```

## 7. Close, adjudicate, compare

```powershell
cortexctl task:close --task $triTask --outcome first_pass
cortexctl adjudicate --task $triTask --real 1 --noise 0 --minutes 5 --note "one real finding, minor, fixed before close"
cortexctl adjudicate --task $controlTask --real 0 --noise 0 --note "no review on the control arm"
cortexctl compare --issue 208
```

```bash
cortexctl task:close --task "$tri_task" --outcome first_pass
cortexctl adjudicate --task "$tri_task" --real 1 --noise 0 --minutes 5 --note "one real finding, minor, fixed before close"
cortexctl adjudicate --task "$control_task" --real 0 --noise 0 --note "no review on the control arm"
cortexctl compare --issue 208
```

`compare` refuses to print a winner if either arm is unadjudicated, so the
adjudication step above is not optional even when the tri arm found nothing.

## 8. Clean up the worktrees

```powershell
git worktree remove ..\uploader-control
git worktree remove ..\uploader-tri
```

```bash
git worktree remove ../uploader-control
git worktree remove ../uploader-tri
```
