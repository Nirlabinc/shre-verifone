param(
  [string]$InstallRoot = "$env:ProgramData\Verifone-Commander-Shre-Cstoresku",
  [string]$RepoUrl = "https://github.com/Nirpat3/Verifone-Commander-Shre-Cstoresku.git",
  [string]$Branch = "master",
  [string]$TunnelName = "verifone-commander-store",
  [string]$TunnelToken = "",
  [string]$PortalHostname = "",
  [string]$DashboardHostname = "",
  [string]$ChatHostname = "",
  [string]$VerifoneHostname = "",
  [string]$VerifoneIp = "",
  [int]$DashboardPort = 5480,
  [string]$LocalAdminToken = "",
  [switch]$InstallCloudflareService,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name, [string]$WingetId)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw "$Name is required and winget is not available. Install $Name before running this script." }
  if (-not $DryRun) {
    winget install --id $WingetId --exact --silent --accept-package-agreements --accept-source-agreements
  }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if ($DryRun) { return $Name }
  throw "$Name install completed, but command was not found on PATH."
}

if ([string]::IsNullOrWhiteSpace($DashboardHostname)) { throw "DashboardHostname is required." }
if ([string]::IsNullOrWhiteSpace($VerifoneHostname)) { throw "VerifoneHostname is required." }

$git = Require-Command -Name "git" -WingetId "Git.Git"
$node = Require-Command -Name "node" -WingetId "OpenJS.NodeJS.LTS"
Require-Command -Name "npm" -WingetId "OpenJS.NodeJS.LTS" | Out-Null

if (-not $DryRun) {
  New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
  if (Test-Path -LiteralPath (Join-Path $InstallRoot ".git")) {
    & $git -C $InstallRoot fetch origin $Branch
    & $git -C $InstallRoot checkout $Branch
    & $git -C $InstallRoot pull --ff-only origin $Branch
  } else {
    & $git clone --branch $Branch $RepoUrl $InstallRoot
  }
  Push-Location $InstallRoot
  try {
    npm install
    npm run build
    powershell -ExecutionPolicy Bypass -File scripts\protect-runtime.ps1 -MarkProtected -Assert
  } finally {
    Pop-Location
  }
}

$env:PORT = [string]$DashboardPort
$env:HOST = "127.0.0.1"
if (-not [string]::IsNullOrWhiteSpace($LocalAdminToken)) { $env:LOCAL_ADMIN_TOKEN = $LocalAdminToken }

$apiProcess = $null
if (-not $DryRun) {
  $apiProcess = Start-Process -FilePath $node -ArgumentList "dist/apps/dashboard-api/src/server.js" -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
}

$cloudflareArgs = @(
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $InstallRoot "scripts\install-cloudflare-remote-access.ps1"),
  "-TunnelName", $TunnelName,
  "-DashboardHostname", $DashboardHostname,
  "-VerifoneHostname", $VerifoneHostname,
  "-DashboardPort", $DashboardPort
)
if (-not [string]::IsNullOrWhiteSpace($PortalHostname)) { $cloudflareArgs += @("-PortalHostname", $PortalHostname) }
if (-not [string]::IsNullOrWhiteSpace($ChatHostname)) { $cloudflareArgs += @("-ChatHostname", $ChatHostname) }
if (-not [string]::IsNullOrWhiteSpace($TunnelToken)) { $cloudflareArgs += @("-TunnelToken", $TunnelToken) }
if (-not [string]::IsNullOrWhiteSpace($VerifoneIp)) { $cloudflareArgs += @("-VerifoneIp", $VerifoneIp) }
if (-not [string]::IsNullOrWhiteSpace($LocalAdminToken)) { $cloudflareArgs += @("-LocalAdminToken", $LocalAdminToken) }
if ($InstallCloudflareService) { $cloudflareArgs += "-InstallService" }
if ($DryRun) { $cloudflareArgs += "-DryRun" }

$cloudflare = & powershell @cloudflareArgs | ConvertFrom-Json

$chatUrl = if ([string]::IsNullOrWhiteSpace($ChatHostname)) {
  "$($cloudflare.dashboardUrl.TrimEnd('/'))/chat"
} else {
  "https://$ChatHostname/chat"
}

$result = [pscustomobject]@{
  ok = $true
  dryRun = [bool]$DryRun
  installRoot = $InstallRoot
  apiProcessId = if ($apiProcess) { $apiProcess.Id } else { $null }
  localDashboard = "http://127.0.0.1:$DashboardPort"
  localPortal = "http://127.0.0.1:$DashboardPort/portal"
  localChat = "http://127.0.0.1:$DashboardPort/chat"
  portalUrl = $cloudflare.portalUrl
  dashboardUrl = $cloudflare.dashboardUrl
  chatUrl = $chatUrl
  verifoneUrl = $cloudflare.verifoneUrl
  verifoneLanUrl = $cloudflare.verifoneLanUrl
  nextSteps = @(
    "Apply Cloudflare Access auth policy to portal/dashboard/chat/verifone hostnames.",
    "Support opens portalUrl, logs in through Cloudflare Access, and completes store setup.",
    "Store operator receives chatUrl for day-to-day questions."
  )
}

$result | ConvertTo-Json -Depth 8
