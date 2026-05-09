param(
  [string]$RuntimePath = "",
  [switch]$Assert,
  [switch]$MarkProtected,
  [switch]$AllowReset
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RuntimePath)) {
  if (-not [string]::IsNullOrWhiteSpace($env:VERIFONE_SHRE_HOME)) {
    $RuntimePath = $env:VERIFONE_SHRE_HOME
  } else {
    $RuntimePath = Join-Path $env:USERPROFILE ".verifone-shre-cstoresku"
  }
}

$resolvedParent = Resolve-Path -LiteralPath (Split-Path -Parent $RuntimePath) -ErrorAction SilentlyContinue
if (-not $resolvedParent) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $RuntimePath) -Force | Out-Null
  $resolvedParent = Resolve-Path -LiteralPath (Split-Path -Parent $RuntimePath)
}

if (-not (Test-Path -LiteralPath $RuntimePath)) {
  New-Item -ItemType Directory -Path $RuntimePath -Force | Out-Null
}

$resolvedRuntime = Resolve-Path -LiteralPath $RuntimePath
$marker = Join-Path $resolvedRuntime ".runtime-protected"

if ($AllowReset) {
  if ($env:ALLOW_VERIFONE_RUNTIME_RESET -ne "I_UNDERSTAND_DELETE_LOCAL_DATA") {
    throw "Runtime reset refused. Set ALLOW_VERIFONE_RUNTIME_RESET=I_UNDERSTAND_DELETE_LOCAL_DATA for support/admin reset."
  }
  Write-Output "Runtime reset override accepted for $resolvedRuntime"
  exit 0
}

if ($MarkProtected -or -not (Test-Path -LiteralPath $marker)) {
  $content = @(
    "protected=true"
    "createdAt=$((Get-Date).ToUniversalTime().ToString('o'))"
    "message=Installer updates must not delete this runtime directory. Use explicit support reset override only."
  )
  Set-Content -LiteralPath $marker -Value $content -Encoding UTF8
}

if ($Assert -or $MarkProtected) {
  if (-not (Test-Path -LiteralPath $marker)) {
    throw "Runtime protection marker missing at $marker"
  }
  Write-Output "Runtime protected: $resolvedRuntime"
}
