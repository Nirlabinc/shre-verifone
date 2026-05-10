param(
  [string]$InstallRoot = "$env:ProgramData\Verifone-Commander-Shre-Cstoresku",
  [int]$Port = 5480,
  [string]$RuntimeRoot = "",
  [string]$LocalAdminToken = "",
  [string]$TaskName = "VerifoneCommanderShreDashboard",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $InstallRoot "scripts\start-dashboard.ps1"
if (-not $DryRun -and -not (Test-Path -LiteralPath $scriptPath)) {
  throw "Start script not found: $scriptPath"
}

$args = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$scriptPath`"",
  "-InstallRoot", "`"$InstallRoot`"",
  "-Port", $Port
)
if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) { $args += @("-RuntimeRoot", "`"$RuntimeRoot`"") }
if (-not [string]::IsNullOrWhiteSpace($LocalAdminToken)) { $args += @("-LocalAdminToken", "`"$LocalAdminToken`"") }

if (-not $DryRun) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($args -join " ")
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

[pscustomobject]@{
  ok = $true
  dryRun = [bool]$DryRun
  taskName = $TaskName
  runAs = "SYSTEM"
  startsAt = "startup"
  command = "powershell.exe $($args -join ' ')"
} | ConvertTo-Json -Depth 4
