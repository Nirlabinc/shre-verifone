param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot
)
# Wrapper invoked by the scheduled task. Sets env so worker.ts loads
# aros-config.json + .install-device-id from the customer's runtime dir,
# then execs node and redirects stdout/stderr to the log dir (scheduled
# tasks run with no terminal, so without this nothing is captured).
# All AROS connection params come from aros-config.json.

$ErrorActionPreference = "Stop"

$env:VERIFONE_SHRE_HOME = $RuntimeRoot
if (-not $env:SHRE_LOG_LEVEL) { $env:SHRE_LOG_LEVEL = "info" }

Set-Location -LiteralPath $InstallRoot

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH — install Node.js 20+ before running" }

$logDir = Join-Path $env:ProgramData "Verifone-Commander-Shre-Cstoresku\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir "shre-connector.log"
$errFile = Join-Path $logDir "shre-connector.err"

# Use Start-Process so we can redirect both streams cleanly and wait.
# -NoNewWindow keeps the child attached to this script's lifetime
# (Stop-ScheduledTask will SIGINT/SIGTERM this script and bubble down).
$proc = Start-Process -FilePath $node `
  -ArgumentList "dist\services\shre-connector\src\worker.js" `
  -WorkingDirectory $InstallRoot `
  -NoNewWindow `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errFile `
  -PassThru

$proc.WaitForExit()
exit $proc.ExitCode
