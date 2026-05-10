param(
  [int]$Port = 5480,
  [string]$RuntimePath = "",
  [switch]$RequireDocker,
  [switch]$RequireCStoreSkuImage,
  [string]$CStoreSkuImage = "varifone-service:latest"
)

$ErrorActionPreference = "Stop"
$results = New-Object System.Collections.Generic.List[object]

function Add-Check {
  param([string]$Id, [bool]$Ok, [string]$Message, [string]$Severity = "critical")
  $script:results.Add([pscustomobject]@{ id = $Id; ok = $Ok; severity = $Severity; message = $Message }) | Out-Null
}

if ([string]::IsNullOrWhiteSpace($RuntimePath)) {
  if (-not [string]::IsNullOrWhiteSpace($env:VERIFONE_SHRE_HOME)) { $RuntimePath = $env:VERIFONE_SHRE_HOME }
  else { $RuntimePath = Join-Path $env:USERPROFILE ".verifone-shre-cstoresku" }
}

$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
Add-Check "node_available" ([bool]$node) "Node.js is available."
Add-Check "npm_available" ([bool]$npm) "npm is available."
if ($node) {
  $nodeVersion = (& node --version).TrimStart("v")
  $major = [int]($nodeVersion.Split(".")[0])
  Add-Check "node_version" ($major -ge 20) "Node.js major version is $major; version 20+ is required."
}

$totalMemoryGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Add-Check "memory" ($totalMemoryGb -ge 4) "Installed RAM is $totalMemoryGb GB; 4 GB minimum, 8 GB recommended." "warning"

$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($RuntimePath).Substring(0,1)) -ErrorAction SilentlyContinue
if ($drive) {
  $freeGb = [math]::Round($drive.Free / 1GB, 1)
  Add-Check "disk_space" ($freeGb -ge 5) "Runtime drive free space is $freeGb GB; 5 GB minimum, 20 GB recommended."
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  Add-Check "port_available_or_owned" $false "Port $Port is already listening; confirm it is the dashboard service." "warning"
} else {
  Add-Check "port_available_or_owned" $true "Port $Port is available." "warning"
}

$runtimeParent = Split-Path -Parent $RuntimePath
if (-not (Test-Path -LiteralPath $runtimeParent)) { New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null }
if (-not (Test-Path -LiteralPath $RuntimePath)) { New-Item -ItemType Directory -Path $RuntimePath -Force | Out-Null }
Add-Check "runtime_writable" (Test-Path -LiteralPath $RuntimePath) "Runtime path exists: $RuntimePath"

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
  foreach ($candidate in @("C:\Program Files\Docker\Docker\resources\bin\docker.exe")) {
    if (Test-Path -LiteralPath $candidate) { $docker = Get-Item -LiteralPath $candidate; break }
  }
}
Add-Check "docker_cli" ([bool]$docker -or -not $RequireDocker) "Docker CLI is available when sidecar mode is required." ($(if ($RequireDocker) { "critical" } else { "warning" }))
if ($docker) {
  $dockerExe = if ($docker.Source) { $docker.Source } else { $docker.FullName }
  $dockerVersion = & $dockerExe --version
  Add-Check "docker_version" ($LASTEXITCODE -eq 0) $dockerVersion "warning"
  $composeVersion = & $dockerExe compose version
  Add-Check "docker_compose" ($LASTEXITCODE -eq 0) $composeVersion ($(if ($RequireDocker) { "critical" } else { "warning" }))
  if ($RequireCStoreSkuImage) {
    $imageId = & $dockerExe image inspect $CStoreSkuImage --format "{{.Id}}" 2>$null
    Add-Check "cstoresku_image" (-not [string]::IsNullOrWhiteSpace($imageId)) "CStoreSKU image is available: $CStoreSkuImage"
  }
}

$criticalFailures = @($results | Where-Object { $_.ok -ne $true -and $_.severity -eq "critical" })
$warningFailures = @($results | Where-Object { $_.ok -ne $true -and $_.severity -ne "critical" })
$summary = [pscustomobject]@{
  ok = $criticalFailures.Count -eq 0
  pilotReady = $criticalFailures.Count -eq 0
  warnings = $warningFailures.Count
  blockers = $criticalFailures.Count
  runtimePath = $RuntimePath
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  checks = $results
}

$summary | ConvertTo-Json -Depth 6
if ($criticalFailures.Count -gt 0) { exit 1 }
