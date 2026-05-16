# Pilot setup for Windows — one-shot from a fresh extract to a running install.
#
#   .\scripts\setup.ps1                                  # interactive (prompts)
#   .\scripts\setup.ps1 -TenantId X -DeviceAlias Y       # non-interactive
#
# Or double-click scripts\setup.cmd which calls this.
# Requires Administrator (the Scheduled Task registers as SYSTEM).

param(
  [string]$TenantId,
  [string]$DeviceAlias,
  [string]$StoreId,
  [string]$UserId,
  [string]$BootstrapKey,
  [ValidateSet("read_only", "read_write")][string]$Mode = "read_only",
  [string]$App = ""
)

$ErrorActionPreference = "Stop"

# ─── locate repo root ────────────────────────────────────────────────────
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $repoRoot

Write-Host "== Verifone Commander Shre Cstoresku — pilot setup =="
Write-Host "Repo: $repoRoot"
Write-Host ""

# ─── elevation check ─────────────────────────────────────────────────────
$principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "ERROR: Run this from an Administrator PowerShell."
  Write-Host "  (the Scheduled Task registers as SYSTEM and needs admin rights)"
  Read-Host "Press Enter to close"
  exit 2
}

# ─── pre-flight ──────────────────────────────────────────────────────────
function Require-Cmd($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: '$name' is required but not installed."
    Write-Host "  $hint"
    Read-Host "Press Enter to close"
    exit 2
  }
}
Require-Cmd "node" "Install Node.js 20+ from https://nodejs.org/"
Require-Cmd "npm"  "Comes with Node.js"

$nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) {
  Write-Host "ERROR: Node $nodeMajor detected; this build needs Node 20 or newer."
  Read-Host "Press Enter to close"; exit 2
}
Write-Host "OK node $(& node -v)"
Write-Host "OK npm  $(& npm -v)"
Write-Host ""

# ─── interactive prompts for missing required ────────────────────────────
if ([string]::IsNullOrWhiteSpace($TenantId)) {
  $TenantId = Read-Host "Shre tenant ID (from the marketplace signup)"
}
if ([string]::IsNullOrWhiteSpace($DeviceAlias)) {
  $DeviceAlias = Read-Host "Friendly name for this device (e.g., 'Front Counter Register')"
}
if ([string]::IsNullOrWhiteSpace($StoreId)) {
  $StoreId = Read-Host "Store ID (or leave blank for 'default')"
  if ([string]::IsNullOrWhiteSpace($StoreId)) { $StoreId = "default" }
}
if ([string]::IsNullOrWhiteSpace($UserId)) {
  $UserId = Read-Host "User ID for AROS event attribution (your work email or chosen handle, leave blank to skip)"
}
if ($Mode -eq "read_write" -and [string]::IsNullOrWhiteSpace($BootstrapKey)) {
  $secure = Read-Host "Bootstrap key (required for read_write mode)" -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $BootstrapKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
}

# ─── install deps + build ────────────────────────────────────────────────
Write-Host ""
Write-Host "== Installing dependencies (this can take 30s) =="
& npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Write-Host ""
Write-Host "== Building =="
& npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

# ─── run the connector installer ─────────────────────────────────────────
Write-Host ""
Write-Host "== Installing shre-connector Scheduled Task =="

$installerArgs = @{
  TenantId    = $TenantId
  DeviceAlias = $DeviceAlias
  StoreId     = $StoreId
  Mode        = $Mode
  InstallRoot = $repoRoot
}
if (-not [string]::IsNullOrWhiteSpace($UserId))       { $installerArgs.UserId = $UserId }
if (-not [string]::IsNullOrWhiteSpace($BootstrapKey)) { $installerArgs.BootstrapKey = $BootstrapKey }
if (-not [string]::IsNullOrWhiteSpace($App))          { $installerArgs.App = $App }

& "$repoRoot\scripts\install-shre-connector.ps1" @installerArgs

Write-Host ""
Write-Host "== Setup complete =="
Write-Host "Task:    VerifoneCommanderShreConnector (Scheduled Task, runs as SYSTEM)"
Write-Host "Config:  $env:ProgramData\Verifone-Commander-Shre-Cstoresku\runtime\aros-config.json"
Write-Host "Logs:    $env:ProgramData\Verifone-Commander-Shre-Cstoresku\logs\shre-connector.{log,err}"
Write-Host ""
Write-Host "Tail logs:  Get-Content $env:ProgramData\Verifone-Commander-Shre-Cstoresku\logs\shre-connector.log -Wait"
Write-Host "Update:     re-run this script with same/new flags"
Write-Host "Uninstall:  .\scripts\install-shre-connector.ps1 -Uninstall"
Write-Host ""
Read-Host "Press Enter to close"
