@echo off
:: Windows double-click wrapper. Self-elevates to Administrator and runs setup.ps1.
:: First time, Windows may ask for confirmation (UAC) — click Yes.

cd /d "%~dp0\.."

:: Self-elevate if not already admin
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Re-launching as Administrator...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs cmd -ArgumentList '/k', '%~f0'"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
