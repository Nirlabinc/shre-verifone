# Install the shre-connector service on a single Windows store device.
#
# Run AFTER the repo is cloned + built (`npm install; npm run build`).
# Idempotent: re-running updates aros-config.json and re-registers the task.
#
# Usage:
#   .\scripts\install-shre-connector.ps1 `
#     -TenantId rapidpos-store-007 `
#     -DeviceAlias "Front Counter Register" `
#     -StoreId store_007 `
#     [-BootstrapKey <key>] `
#     [-Mode read_only|read_write] `
#     [-App verifone_commander_cstoresku] `
#     [-RuntimeRoot "$env:ProgramData\Verifone-Commander-Shre-Cstoresku\runtime"] `
#     [-InstallRoot "<repo-path>"]
#
#   .\scripts\install-shre-connector.ps1 -Uninstall
#
# Mirrors scripts/install-shre-connector.sh (the macOS/Linux installer).
# Requires Administrator (Scheduled Task registers as SYSTEM with AtStartup).

param(
  [string]$TenantId,
  [string]$DeviceAlias,
  [string]$StoreId = "default",
  [string]$UserId = "",
  [string]$BootstrapKey = "",
  [ValidateSet("read_only", "read_write")][string]$Mode = "read_only",
  [string]$App = "verifone_commander_cstoresku",
  [string]$InstallRoot = "",
  [string]$RuntimeRoot = "",
  [string]$TaskName = "VerifoneCommanderShreConnector",
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ─── defaults ─────────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
  $InstallRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $env:ProgramData "Verifone-Commander-Shre-Cstoresku\runtime"
}
$LogDir = Join-Path $env:ProgramData "Verifone-Commander-Shre-Cstoresku\logs"

# ─── uninstall path ───────────────────────────────────────────────────────
if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    [pscustomobject]@{ ok = $true; removed = $TaskName } | ConvertTo-Json
  } else {
    [pscustomobject]@{ ok = $true; removed = $false; reason = "no task named $TaskName" } | ConvertTo-Json
  }
  Write-Host ""
  Write-Host "(aros-config.json and .install-device-id at $RuntimeRoot preserved — delete manually if reinstalling cleanly)"
  return
}

# ─── validate required args ───────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($TenantId)) { throw "-TenantId is required" }
if ([string]::IsNullOrWhiteSpace($DeviceAlias)) { throw "-DeviceAlias is required" }
if ($Mode -eq "read_write" -and [string]::IsNullOrWhiteSpace($BootstrapKey)) {
  throw "-Mode read_write requires -BootstrapKey"
}
if ($App -notmatch '^[a-z][a-z0-9_-]{0,31}$') {
  throw "-App must match ^[a-z][a-z0-9_-]{0,31}`$"
}

# ─── pre-flight ───────────────────────────────────────────────────────────
$workerJs = Join-Path $InstallRoot "dist\services\shre-connector\src\worker.js"
if (-not (Test-Path -LiteralPath $workerJs)) {
  throw "Built worker not found at $workerJs`nRun: cd '$InstallRoot'; npm install; npm run build"
}
$startScript = Join-Path $PSScriptRoot "start-shre-connector.ps1"
if (-not (Test-Path -LiteralPath $startScript)) {
  throw "Wrapper script not found at $startScript"
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not on PATH — install Node.js 20+ first" }

Write-Host "install-root  = $InstallRoot"
Write-Host "runtime-root  = $RuntimeRoot"
Write-Host "node          = $node ($(& $node -v))"
Write-Host "tenant-id     = $TenantId"
Write-Host "app           = $App"
Write-Host "mode          = $Mode"
Write-Host "store-id      = $StoreId"
Write-Host "device-alias  = $DeviceAlias"
$userIdDisplay = if ([string]::IsNullOrWhiteSpace($UserId)) { "(unset — events will carry no userId)" } else { $UserId }
Write-Host "user-id       = $userIdDisplay"
Write-Host "task-name     = $TaskName"
Write-Host ""

# ─── write aros-config.json ───────────────────────────────────────────────
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$configPath = Join-Path $RuntimeRoot "aros-config.json"
$cfg = [ordered]@{
  tenantId    = $TenantId
  app         = $App
  mode        = $Mode
  storeId     = $StoreId
  deviceAlias = $DeviceAlias
}
if (-not [string]::IsNullOrWhiteSpace($UserId))       { $cfg.userId = $UserId }
if (-not [string]::IsNullOrWhiteSpace($BootstrapKey)) { $cfg.bootstrapKey = $BootstrapKey }
if ($DryRun) {
  Write-Host "[dry-run] would write $configPath :"
  $cfg | ConvertTo-Json
} else {
  $cfg | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  # Lock the config file to admins+SYSTEM only (per-store credentials live here)
  $acl = Get-Acl -LiteralPath $configPath
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    "BUILTIN\Administrators", "FullControl", "Allow")))
  $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    "NT AUTHORITY\SYSTEM", "FullControl", "Allow")))
  Set-Acl -LiteralPath $configPath -AclObject $acl
  Write-Host "wrote $configPath (admins+SYSTEM only)"
}

# ─── register scheduled task ──────────────────────────────────────────────
$argList = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$startScript`"",
  "-InstallRoot", "`"$InstallRoot`"",
  "-RuntimeRoot", "`"$RuntimeRoot`""
)

if ($DryRun) {
  Write-Host ""
  Write-Host "[dry-run] would register task ${TaskName} with action:"
  Write-Host "  powershell.exe $($argList -join ' ')"
  return
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($argList -join " ") -WorkingDirectory $InstallRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 6

# ─── verify ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "── post-install verification ──"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$info = $task | Get-ScheduledTaskInfo
[pscustomobject]@{
  taskName       = $task.TaskName
  state          = $task.State
  lastRunTime    = $info.LastRunTime
  lastTaskResult = $info.LastTaskResult
  numberOfMissed = $info.NumberOfMissedRuns
} | Format-List

$logFile = Join-Path $LogDir "shre-connector.log"
if (Test-Path -LiteralPath $logFile) {
  Write-Host "── log tail ──"
  Get-Content -LiteralPath $logFile -Tail 15
} else {
  Write-Host "(no log file at $logFile yet — connector may still be initializing or stdout not redirected)"
  Write-Host "Check Event Viewer → TaskScheduler for runtime errors."
}

Write-Host ""
Write-Host "── done ──"
Write-Host "Config:    $configPath"
Write-Host "Logs:      $LogDir\shre-connector.log (if redirected) / Event Viewer otherwise"
Write-Host "Task:      $TaskName (AtStartup, runs as SYSTEM)"
Write-Host "Update:    re-run this script with new flags"
Write-Host "Remove:    .\scripts\install-shre-connector.ps1 -Uninstall"
