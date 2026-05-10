param(
  [string]$AccountId = $env:CLOUDFLARE_ACCOUNT_ID,
  [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN,
  [string]$PortalHostname = "",
  [string]$DashboardHostname = "",
  [string]$ChatHostname = "",
  [string]$VerifoneHostname = "",
  [string[]]$SupportEmails = @(),
  [string[]]$OperatorEmails = @(),
  [string]$SessionDuration = "24h",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Invoke-CfApi {
  param([string]$Method, [string]$Path, [object]$Body = $null)
  if ([string]::IsNullOrWhiteSpace($AccountId)) { throw "CLOUDFLARE_ACCOUNT_ID or -AccountId is required." }
  if ([string]::IsNullOrWhiteSpace($ApiToken)) { throw "CLOUDFLARE_API_TOKEN or -ApiToken is required." }
  $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId$Path"
  $headers = @{ authorization = "Bearer $ApiToken"; "content-type" = "application/json" }
  if ($DryRun) {
    return @{ dryRun = $true; method = $Method; uri = $uri; body = $Body }
  }
  $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 10 } else { $null }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json
}

function New-AccessApp {
  param([string]$Name, [string]$Hostname, [string]$Path = "")
  if ([string]::IsNullOrWhiteSpace($Hostname)) { return $null }
  Invoke-CfApi -Method "POST" -Path "/access/apps" -Body @{
    name = $Name
    domain = $Hostname
    type = "self_hosted"
    session_duration = $SessionDuration
    allowed_idps = @()
    auto_redirect_to_identity = $false
    app_launcher_visible = $true
    path = $Path
  }
}

function Access-IncludeEmails {
  param([string[]]$Emails)
  $items = @()
  foreach ($email in $Emails) {
    if (-not [string]::IsNullOrWhiteSpace($email)) {
      $items += @{ email = @{ email = $email.Trim() } }
    }
  }
  if ($items.Count -eq 0) { $items += @{ everyone = @{} } }
  return $items
}

function New-AccessPolicy {
  param([object]$App, [string]$Name, [string[]]$Emails)
  if ($null -eq $App) { return $null }
  $appId = if ($DryRun) { "dry-run-app-id" } else { $App.result.id }
  $include = @(Access-IncludeEmails -Emails $Emails)
  Invoke-CfApi -Method "POST" -Path "/access/apps/$appId/policies" -Body @{
    name = $Name
    decision = "allow"
    precedence = 1
    include = $include
    require = @()
    exclude = @()
  }
}

$support = $SupportEmails
$operators = if ($OperatorEmails.Count -gt 0) { $OperatorEmails } else { $SupportEmails }
$apps = @()
$apps += @{ role = "portal"; app = New-AccessApp -Name "Verifone Commander Portal" -Hostname $PortalHostname -Path "/portal" }
$apps += @{ role = "dashboard"; app = New-AccessApp -Name "Verifone Commander Dashboard" -Hostname $DashboardHostname }
$apps += @{ role = "chat"; app = New-AccessApp -Name "Verifone Commander Chat" -Hostname $ChatHostname -Path "/chat" }
$apps += @{ role = "verifone"; app = New-AccessApp -Name "Verifone Commander ConfigClient" -Hostname $VerifoneHostname -Path "/ConfigClient.html" }

$policies = @()
foreach ($entry in $apps) {
  if ($null -eq $entry.app) { continue }
  $emails = if ($entry.role -eq "chat") { $operators } else { $support }
  $policies += New-AccessPolicy -App $entry.app -Name "$($entry.role)-allow" -Emails $emails
}

[pscustomobject]@{
  ok = $true
  dryRun = [bool]$DryRun
  accountId = if ([string]::IsNullOrWhiteSpace($AccountId)) { "" } else { $AccountId }
  apps = $apps
  policies = $policies
  notes = @(
    "This creates self-hosted Access apps and email allow policies.",
    "DNS routes and tunnel token provisioning are still controlled by the Cloudflare tunnel setup.",
    "For production, restrict email lists or groups instead of using everyone."
  )
} | ConvertTo-Json -Depth 12
