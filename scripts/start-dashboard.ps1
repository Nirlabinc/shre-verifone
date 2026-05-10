param(
  [string]$InstallRoot = "$PSScriptRoot\..",
  [int]$Port = 5480,
  [string]$HostAddress = "127.0.0.1",
  [string]$RuntimeRoot = "",
  [string]$LocalAdminToken = ""
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
Set-Location $resolvedRoot

$env:PORT = [string]$Port
$env:HOST = $HostAddress
if (-not [string]::IsNullOrWhiteSpace($RuntimeRoot)) { $env:VERIFONE_SHRE_HOME = $RuntimeRoot }
if (-not [string]::IsNullOrWhiteSpace($LocalAdminToken)) { $env:LOCAL_ADMIN_TOKEN = $LocalAdminToken }

node dist/apps/dashboard-api/src/server.js
