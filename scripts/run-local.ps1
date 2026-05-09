$ErrorActionPreference = "Stop"
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (Test-Path "node_modules")) {
    npm install
}
npm run build
powershell -ExecutionPolicy Bypass -File scripts/protect-runtime.ps1 -MarkProtected -Assert
npm run start:api
