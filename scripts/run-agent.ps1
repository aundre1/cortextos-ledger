<#
.SYNOPSIS
  Launch one OpenCode agent detached and record the result to a run directory.

.DESCRIPTION
  This is a low level, OpenCode-specific launcher, ported from an earlier
  standalone tool. The preferred path for cortextos-ledger is
  `cortexctl run:launch`, which does everything this script does (preflight,
  detached spawn, credential boundary, watchdog) plus the ledger bookkeeping
  (attempts, spend, escalations) that this script has no idea about. Use this
  script only when you want to drive OpenCode directly, outside the ledger,
  for example while developing a new agent definition.

  Two constraints below are load bearing; do not simplify them away:

  1. The prompt goes in as a POSITIONAL argument, never piped on stdin. A
     detached process has no console, so a stdin pipe never closes and
     opencode hangs forever.
  2. -Auto (OpenCode's --auto flag) is required whenever the OpenCode config's
     bash/edit permissions are "ask" rather than "allow". Without it, a
     headless run blocks forever on an approval prompt nobody can answer.

.PARAMETER Worktree
  Absolute path to the git worktree the agent should run in. No default: the
  caller always states it explicitly.

.PARAMETER AllowDirty
  Skip the uncommitted-work check. Off by default. Passing this means you
  accept that an unattended agent may delete or overwrite uncommitted work in
  Worktree.
#>
param(
  [Parameter(Mandatory=$true)][string]$Agent,
  [Parameter(Mandatory=$true)][string]$PromptFile,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [Parameter(Mandatory=$true)][string]$Worktree,
  [string]$Model = "",
  [string]$TaskId = "",
  [string]$RunId = "",
  [string[]]$Attach = @(),
  [switch]$AllowDirty
)

# PRE-FLIGHT: never launch an agent into a tree with uncommitted tracked
# changes. The single most destructive failure this kit's guards exist to
# prevent is an agent deleting uncommitted work during an unattended run. The
# agent gets a clean tree or it does not run.
$dirty = @(git -C $Worktree status --porcelain --untracked-files=no 2>$null)
if ($dirty.Count -gt 0 -and -not $AllowDirty) {
  Write-Error ("REFUSING TO LAUNCH: $Worktree has $($dirty.Count) uncommitted tracked change(s). " +
    "Commit or stash first, or pass -AllowDirty if you accept that an agent may destroy them.`n" +
    ($dirty | Select-Object -First 10 | Out-String))
  exit 2
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Remove-Item (Join-Path $OutDir "done.marker") -ErrorAction SilentlyContinue

$attachArgs = ($Attach | ForEach-Object { "'-f','$_'" }) -join ','
if ($attachArgs) { $attachArgs = ",$attachArgs" }

$inner = @"
`$ErrorActionPreference='Continue'
Set-Location '$Worktree'
`$env:CORTEXOS_TASK_ID = '$TaskId'
`$env:CORTEXOS_RUN_ID  = '$RunId'
`$env:CORTEXOS_RUN_DIR = '$OutDir'
`$prompt = Get-Content -Raw '$PromptFile'
`$a = @('run','--agent','$Agent','--auto')
if ('$Model') { `$a += @('--model','$Model') }
`$a += @($attachArgs.TrimStart(','))
`$a = `$a | Where-Object { `$_ -ne '' }
`$a += `$prompt
`$sw = [Diagnostics.Stopwatch]::StartNew()
& opencode @a *> (Join-Path '$OutDir' 'out.txt')
`$code = `$LASTEXITCODE
`$sw.Stop()
Set-Content (Join-Path '$OutDir' 'exit.txt') "`$code"
Set-Content (Join-Path '$OutDir' 'elapsed_ms.txt') "`$(`$sw.ElapsedMilliseconds)"
Set-Content (Join-Path '$OutDir' 'done.marker') (Get-Date -Format o)
"@

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoProfile","-NonInteractive","-EncodedCommand",$encoded `
  -WindowStyle Hidden
Write-Output "launched agent=$Agent out=$OutDir"
