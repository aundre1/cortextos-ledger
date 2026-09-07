<#
.SYNOPSIS
  Poll a detached agent run started by run-agent.ps1.

.DESCRIPTION
  Low level companion to run-agent.ps1. The preferred path for
  cortextos-ledger is `cortexctl watch --run <id>`, which is what
  `run:launch` starts automatically and which also enforces the wall clock
  and stall limits and writes escalations. This script only reports status;
  it does not enforce anything and it does not know about the ledger.

.PARAMETER OutDir
  The same OutDir that was passed to run-agent.ps1 for this run. No default.
#>
param(
  [Parameter(Mandatory=$true)][string]$OutDir,
  [int]$TailLines = 60
)
$done = Join-Path $OutDir "done.marker"
if (Test-Path $done) {
  $code = (Get-Content (Join-Path $OutDir 'exit.txt') -ErrorAction SilentlyContinue)
  $ms   = (Get-Content (Join-Path $OutDir 'elapsed_ms.txt') -ErrorAction SilentlyContinue)
  Write-Output "STATUS=done EXIT=$code ELAPSED_MS=$ms"
  Write-Output "--- tail ---"
  Get-Content (Join-Path $OutDir 'out.txt') -Tail $TailLines -ErrorAction SilentlyContinue
} else {
  $sz = if (Test-Path (Join-Path $OutDir 'out.txt')) { (Get-Item (Join-Path $OutDir 'out.txt')).Length } else { 0 }
  Write-Output "STATUS=running BYTES=$sz"
  Get-Content (Join-Path $OutDir 'out.txt') -Tail 10 -ErrorAction SilentlyContinue
}
