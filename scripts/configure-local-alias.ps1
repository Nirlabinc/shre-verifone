param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Check,
  [string[]]$Aliases = @("cstoresku", "cstoresku.local")
)

$ErrorActionPreference = "Stop"
$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$begin = "# BEGIN Verifone Commander Shre CStoreSKU local aliases"
$end = "# END Verifone Commander Shre CStoreSKU local aliases"

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-Hosts {
  if (Test-Path $hostsPath) { return Get-Content -Raw -LiteralPath $hostsPath }
  return ""
}

function Remove-Block([string]$content) {
  $pattern = "(?ms)^\Q$begin\E\r?\n.*?^\Q$end\E\r?\n?"
  return [regex]::Replace($content, $pattern, "")
}

function Alias-Block {
  $aliasText = ($Aliases | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }) -join " "
  return "$begin`r`n127.0.0.1 $aliasText`r`n::1 $aliasText`r`n$end`r`n"
}

if (-not ($Install -or $Remove -or $Check)) {
  throw "Choose one action: -Install, -Remove, or -Check."
}

$content = Read-Hosts

if ($Check) {
  $hasBlock = $content.Contains($begin) -and $content.Contains($end)
  [pscustomobject]@{
    HostsPath = $hostsPath
    Installed = $hasBlock
    Aliases = $Aliases
    Urls = $Aliases | ForEach-Object { "http://$($_):5480" }
  } | Format-List
  exit 0
}

if (-not (Test-Admin)) {
  throw "Administrator privileges are required to modify $hostsPath."
}

$updated = Remove-Block $content
if ($Install) {
  $updated = $updated.TrimEnd() + "`r`n" + (Alias-Block)
}

Set-Content -LiteralPath $hostsPath -Value $updated -Encoding ASCII
Write-Host "Updated $hostsPath"
