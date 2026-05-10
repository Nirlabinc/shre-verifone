param(
  [string]$TunnelName = "verifone-commander-store",
  [string]$TunnelToken = "",
  [string]$PortalHostname = "",
  [string]$DashboardHostname = "",
  [string]$VerifoneHostname = "",
  [string]$VerifoneIp = "",
  [string[]]$CandidateIps = @("192.168.14.11", "192.168.31.11", "192.168.1.11", "192.168.0.11"),
  [int]$DashboardPort = 5480,
  [string]$LocalAdminToken = "",
  [switch]$InstallService,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Find-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($path in @(
    "C:\Program Files\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
  )) {
    if (Test-Path -LiteralPath $path) { return $path }
  }
  return ""
}

function Install-Cloudflared {
  $existing = Find-Cloudflared
  if ($existing) { return $existing }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw "cloudflared is not installed and winget is not available. Install Cloudflare cloudflared manually." }
  if ($DryRun) { return "cloudflared" }
  winget install --id Cloudflare.cloudflared --exact --silent --accept-package-agreements --accept-source-agreements
  $installed = Find-Cloudflared
  if (-not $installed) { throw "cloudflared install completed, but executable was not found on PATH or common locations." }
  return $installed
}

function Test-VerifoneCandidate {
  param([string]$Ip)
  foreach ($path in @("/ConfigClient.html", "/")) {
    try {
      $response = Invoke-WebRequest -Uri "http://$Ip$path" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return [pscustomobject]@{ ok = $true; ip = $Ip; url = "http://$Ip/ConfigClient.html"; statusCode = $response.StatusCode }
      }
    } catch {
    }
  }
  return [pscustomobject]@{ ok = $false; ip = $Ip; url = "http://$Ip/ConfigClient.html"; statusCode = 0 }
}

if ([string]::IsNullOrWhiteSpace($DashboardHostname)) {
  throw "DashboardHostname is required, for example store001-dashboard.aros.live"
}
if ([string]::IsNullOrWhiteSpace($VerifoneHostname)) {
  throw "VerifoneHostname is required, for example store001-verifone.aros.live"
}

$cloudflared = Install-Cloudflared

$probeResults = @()
if ([string]::IsNullOrWhiteSpace($VerifoneIp)) {
  foreach ($candidate in $CandidateIps) {
    $result = Test-VerifoneCandidate -Ip $candidate
    $probeResults += $result
    if ($result.ok) {
      $VerifoneIp = $candidate
      break
    }
  }
}
if ([string]::IsNullOrWhiteSpace($VerifoneIp)) {
  throw "Unable to auto-detect Verifone IP. Pass -VerifoneIp after confirming the store LAN address."
}

$dashboardUrl = "https://$DashboardHostname"
$portalUrl = if ([string]::IsNullOrWhiteSpace($PortalHostname)) { "$dashboardUrl/portal" } else { "https://$PortalHostname/portal" }
$verifoneUrl = "https://$VerifoneHostname/ConfigClient.html"
$verifoneLanUrl = "http://$VerifoneIp/ConfigClient.html"
$configRoot = Join-Path $env:ProgramData "cloudflared"
$configPath = Join-Path $configRoot "$TunnelName.yml"
if (-not $DryRun) { New-Item -ItemType Directory -Path $configRoot -Force | Out-Null }

$config = @"
tunnel: $TunnelName
ingress:
$(if (-not [string]::IsNullOrWhiteSpace($PortalHostname)) { "  - hostname: $PortalHostname`n    service: http://localhost:$DashboardPort`n" } else { "" })  - hostname: $DashboardHostname
    service: http://localhost:$DashboardPort
  - hostname: $VerifoneHostname
    service: http://$VerifoneIp
  - service: http_status:404
"@

if (-not $DryRun) {
  Set-Content -LiteralPath $configPath -Value $config -Encoding UTF8
}

$serviceCommand = ""
if ($InstallService) {
  if ([string]::IsNullOrWhiteSpace($TunnelToken)) {
    throw "TunnelToken is required to install the cloudflared service non-interactively. Create the tunnel in Cloudflare Zero Trust and pass the token."
  }
  $serviceCommand = "`"$cloudflared`" service install <redacted-token>"
  if (-not $DryRun) {
    & $cloudflared service install $TunnelToken
  }
}

$apiUpdate = $null
try {
  $headers = @{ "content-type" = "application/json" }
  if (-not [string]::IsNullOrWhiteSpace($LocalAdminToken)) { $headers["x-local-admin-token"] = $LocalAdminToken }
  $body = @{
    provider = "cloudflare"
    enabled = $true
    tunnelId = $TunnelName
    publicUrl = $dashboardUrl
    portalUrl = $portalUrl
    dashboardUrl = $dashboardUrl
    verifoneUrl = $verifoneUrl
    verifoneLanUrl = $verifoneLanUrl
    verifoneDetectedIp = $VerifoneIp
  } | ConvertTo-Json
  if (-not $DryRun) {
    $apiUpdate = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$DashboardPort/api/remote-access" -Headers $headers -Body $body -TimeoutSec 5
  }
} catch {
  $apiUpdate = @{ warning = "Dashboard remote-access update failed or requires local login/admin token."; error = $_.Exception.Message }
}

[pscustomobject]@{
  ok = $true
  dryRun = [bool]$DryRun
  cloudflared = $cloudflared
  tunnelName = $TunnelName
  configPath = $configPath
  dashboardUrl = $dashboardUrl
  portalUrl = $portalUrl
  verifoneUrl = $verifoneUrl
  verifoneLanUrl = $verifoneLanUrl
  detectedVerifoneIp = $VerifoneIp
  probeResults = $probeResults
  serviceInstallCommand = $serviceCommand
  apiUpdate = $apiUpdate
  nextSteps = @(
    "Create DNS routes in Cloudflare Zero Trust for $DashboardHostname and $VerifoneHostname.",
    "Optional portal hostname route: $PortalHostname -> http://localhost:$DashboardPort.",
    "Apply Cloudflare Access policies and MFA to both hostnames.",
    "Run: cloudflared tunnel run $TunnelName, or install service with -InstallService -TunnelToken.",
    "Open $portalUrl, $dashboardUrl and $verifoneUrl through Cloudflare Access."
  )
} | ConvertTo-Json -Depth 8
