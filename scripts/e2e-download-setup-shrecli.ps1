param(
  [string]$RepoUrl = "https://github.com/Nirpat3/Verifone-Commander-Shre-Cstoresku.git",
  [string]$Branch = "master",
  [string]$SourcePath = "",
  [string]$ConnectorSecret = "download-e2e-secret"
)

$ErrorActionPreference = "Stop"
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("verifone-shre-download-e2e-" + [System.Guid]::NewGuid().ToString("N"))
$repo = Join-Path $root "repo"
$runtime = Join-Path $root "runtime"
$port = Get-Random -Minimum 22000 -Maximum 45000
$baseUrl = "http://127.0.0.1:$port"

New-Item -ItemType Directory -Force -Path $root | Out-Null

try {
  if ($SourcePath) {
    robocopy $SourcePath $repo /MIR /XD .git node_modules dist /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }
  } else {
    git clone --branch $Branch --depth 1 $RepoUrl $repo
  }

  Push-Location $repo
  npm install
  npm run build

  $env:PORT = "$port"
  $env:HOST = "127.0.0.1"
  $env:VERIFONE_SHRE_HOME = $runtime
  $env:CONNECTOR_SHARED_SECRET = $ConnectorSecret
  $env:LOCAL_ADMIN_TOKEN = "download-e2e-admin-token"
  $env:LOCAL_BASE_URL = $baseUrl
  $api = Start-Process -FilePath node -ArgumentList "dist/apps/dashboard-api/src/server.js" -WorkingDirectory $repo -WindowStyle Hidden -PassThru

  $deadline = (Get-Date).AddSeconds(20)
  do {
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -UseBasicParsing
      if ($health.ok) { break }
    } catch {}
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  if (-not $health.ok) { throw "API did not become healthy at $baseUrl" }

  $json = "application/json"
  $adminHeaders = @{ "x-local-admin-token" = $env:LOCAL_ADMIN_TOKEN }
  Invoke-RestMethod -Uri "$baseUrl/api/auth/setup" -Method Post -Headers $adminHeaders -ContentType $json -Body (@{
    loginSecret = "download-e2e-login-secret"
  } | ConvertTo-Json) | Out-Null

  Invoke-RestMethod -Uri "$baseUrl/api/profile" -Method Post -Headers $adminHeaders -ContentType $json -Body (@{
    company = "Rapid Infosoft LLC"
    storeId = "store_001"
    contactEmail = "info@rapidinfosoft.com"
    timezone = "America/New_York"
  } | ConvertTo-Json) | Out-Null

  Invoke-RestMethod -Uri "$baseUrl/api/verifone/config" -Method Post -Headers $adminHeaders -ContentType $json -Body (@{
    commanderUrl = "http://192.0.2.10"
    username = "manager"
    password = "download-e2e-password"
    applicationKey = "download-e2e-key"
  } | ConvertTo-Json) | Out-Null

  Invoke-RestMethod -Uri "$baseUrl/api/verifone/validate" -Method Post -Headers $adminHeaders -ContentType $json -Body (@{ daysRemaining = 30 } | ConvertTo-Json) | Out-Null

  Invoke-RestMethod -Uri "$baseUrl/api/connector/activate" -Method Post -Headers $adminHeaders -ContentType $json -Body (@{
    connectorId = "verifone-commander"
    connectorName = "Verifone Commander"
    tenantId = "tenant_rapid_001"
    storeId = "store_001"
    app = "verifone_cstoresku"
    cloudRelayEnabled = $true
    registryUrl = "https://connector.aros.live"
    relatedConnectors = @("rapidrms-api")
  } | ConvertTo-Json) | Out-Null

  Invoke-RestMethod -Uri "$baseUrl/api/sales/snapshot" -Method Post -Headers $adminHeaders -ContentType $json -Body (@{
    businessDate = (Get-Date).ToString("yyyy-MM-dd")
    totalSales = 1234.56
    transactionCount = 42
    topItems = @(@{ name = "Coffee"; quantity = 20; sales = 40.00 })
    source = "download-e2e"
  } | ConvertTo-Json -Depth 5) | Out-Null

  node scripts/shre-cli-message.mjs --base-url $baseUrl --secret $ConnectorSecret --tenant tenant_rapid_001 --store store_001 --source shre-cli --message "What were sales today?"
  if ($LASTEXITCODE -ne 0) { throw "shre-cli message simulation failed" }

  $audit = Invoke-RestMethod -Uri "$baseUrl/api/messages/audit" -Headers $adminHeaders -UseBasicParsing
  if (-not $audit.messages -or $audit.messages.Count -lt 1) { throw "No message audit was recorded" }

  Write-Host "Download/setup/shre-cli E2E passed at $baseUrl"
} finally {
  if ($api -and -not $api.HasExited) { Stop-Process -Id $api.Id -Force }
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
