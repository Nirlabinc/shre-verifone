param(
  [int]$Port = 5480,
  [string]$RuntimePath = "",
  [string]$BackupRoot = "",
  [string]$ServiceName = "VerifoneCommanderShreCstoresku",
  [string]$ExpectedVersion = "",
  [switch]$SkipInstall,
  [switch]$SkipGitPull,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Resolve-RuntimePath {
  param([string]$InputPath)
  if (-not [string]::IsNullOrWhiteSpace($InputPath)) { return $InputPath }
  if (-not [string]::IsNullOrWhiteSpace($env:VERIFONE_SHRE_HOME)) { return $env:VERIFONE_SHRE_HOME }
  return (Join-Path $env:USERPROFILE ".verifone-shre-cstoresku")
}

function Invoke-HealthWait {
  param([int]$Port, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $health = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -Method Get -TimeoutSec 3
      return $health
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)
  throw "Dashboard API did not become healthy on port $Port within $TimeoutSeconds seconds."
}

function Invoke-Smoke {
  param([int]$Port, [string]$ExpectedVersion)
  $health = Invoke-HealthWait -Port $Port
  if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and $health.version.version -ne $ExpectedVersion) {
    throw "Version mismatch. Expected $ExpectedVersion but running $($health.version.version)."
  }

  $version = Invoke-RestMethod -Uri "http://localhost:$Port/api/version" -Method Get -TimeoutSec 5
  $worker = Invoke-RestMethod -Uri "http://localhost:$Port/api/heartbeat/worker" -Method Get -TimeoutSec 5
  $ping = Invoke-WebRequest -Uri "http://localhost:$Port/api/verifone/ping" -Method Post -ContentType "application/json" -Body "{}" -TimeoutSec 8 -SkipHttpErrorCheck
  if ($ping.StatusCode -eq 404) {
    throw "Smoke failed: /api/verifone/ping returned 404, which means the old API process is still running or the build is stale."
  }

  [pscustomobject]@{
    ok = $true
    health = $health.ok
    version = $version.version
    cacheKey = $version.cacheKey
    heartbeatWorkerEnabled = $worker.enabled
    pingStatusCode = $ping.StatusCode
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
}

$RuntimePath = Resolve-RuntimePath -InputPath $RuntimePath
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  $BackupRoot = Join-Path $env:USERPROFILE "VerifoneCommanderBackups"
}

Write-Output "Starting production update for Verifone Commander Shre CStoreSKU"
Write-Output "Runtime: $RuntimePath"
Write-Output "Backup root: $BackupRoot"

powershell -ExecutionPolicy Bypass -File scripts/protect-runtime.ps1 -RuntimePath $RuntimePath -MarkProtected -Assert | Write-Output

if (-not $SkipGitPull -and (Test-Path ".git")) {
  git pull --ff-only
}

if (-not $SkipInstall) {
  npm install
}
npm run build

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne "Stopped") {
    Write-Output "Stopping service $ServiceName"
    Stop-Service -Name $ServiceName -Force
    $service.WaitForStatus("Stopped", "00:00:30")
  }
} else {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $processId = $listener.OwningProcess
    if ($processId -and $processId -ne $PID) {
      Write-Output "Stopping process $processId listening on port $Port"
      Stop-Process -Id $processId -Force
    }
  }
  Start-Sleep -Seconds 1
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$backupPath = Join-Path $BackupRoot "update-$stamp"
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
foreach ($fileName in @("runtime.sqlite", ".install-secret", ".runtime-protected")) {
  $source = Join-Path $RuntimePath $fileName
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $backupPath $fileName) -Force
  }
}
Set-Content -LiteralPath (Join-Path $backupPath "backup-manifest.json") -Encoding UTF8 -Value (@{
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  sourceRuntime = $RuntimePath
  reason = "production-update"
  encrypted = $true
} | ConvertTo-Json -Depth 5)
Write-Output "Runtime backup created: $backupPath"

if ($NoStart) {
  Write-Output "NoStart specified. Update stopped after backup/build."
  exit 0
}

if ($service) {
  Write-Output "Starting service $ServiceName"
  Start-Service -Name $ServiceName
} else {
  Write-Output "Starting dashboard API process on port $Port"
  $env:PORT = [string]$Port
  $env:HOST = "127.0.0.1"
  $env:VERIFONE_SHRE_HOME = $RuntimePath
  Start-Process -FilePath "node" -ArgumentList "dist/apps/dashboard-api/src/server.js" -WorkingDirectory (Get-Location).Path -WindowStyle Hidden
}

$result = Invoke-Smoke -Port $Port -ExpectedVersion $ExpectedVersion
$result | ConvertTo-Json -Depth 8
Write-Output "Production update completed and smoke checks passed."
