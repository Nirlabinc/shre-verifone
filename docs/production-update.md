# Production Update And Restart

Production updates must restart the running service after new code is installed. Otherwise the old Node process can keep serving stale API routes, even when the files on disk are updated.

## Required Update Flow

```text
protect runtime
pull/download release
install dependencies
build
stop running service/process
backup runtime.sqlite + .install-secret
start service/process
verify health/version/endpoints
```

This is enforced by:

```powershell
npm run update:prod
```

On Linux/macOS:

```bash
./scripts/production-update.sh
```

## Windows Behavior

`scripts/production-update.ps1`:

1. Marks and checks the protected runtime folder.
2. Runs `git pull --ff-only` unless `-SkipGitPull` is used.
3. Runs `npm install` unless `-SkipInstall` is used.
4. Runs `npm run build`.
5. Stops Windows service `VerifoneCommanderShreCstoresku` if installed.
6. If no service exists, stops the process listening on port `5480`.
7. Copies `runtime.sqlite`, `.install-secret`, and `.runtime-protected` into an update backup folder.
8. Starts the Windows service or a hidden Node API process.
9. Runs smoke checks.

## Smoke Checks

The update fails if:

- `GET /api/health` does not become healthy.
- `GET /api/version` does not return the expected version when `-ExpectedVersion` is provided.
- `GET /api/capabilities` does not advertise `errorLog`, `commanderWriteBack`, and at least 200 PDK commands.
- `POST /api/verifone/ping` returns `404`, which means the running process is stale or the build did not include the current API.

The update smoke check intentionally verifies non-sensitive capability flags and the PDK catalog size so an old process left on port `5480` is detected instead of passing a generic health check. Sensitive endpoints such as diagnostics and error details remain protected by local login/session or `LOCAL_ADMIN_TOKEN`.

`POST /api/verifone/ping` may return `503` when Commander is not configured or unreachable. That is acceptable for an update smoke check because it proves the current route exists. Operational Commander connectivity is handled by heartbeat/readiness alerts.

## Options

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/production-update.ps1 `
  -Port 5480 `
  -ServiceName VerifoneCommanderShreCstoresku `
  -ExpectedVersion 0.1.0
```

Linux/macOS:

```bash
PORT=5480 \
SERVICE_NAME=verifone-commander-shre-cstoresku \
EXPECTED_VERSION=0.1.0 \
./scripts/production-update.sh
```

## Runtime Backup

Backups are written to:

```text
Windows: %USERPROFILE%\VerifoneCommanderBackups\update-<timestamp>
macOS/Linux: ~/VerifoneCommanderBackups/update-<timestamp>
```

Each backup includes:

- `runtime.sqlite`
- `.install-secret`
- `.runtime-protected`
- `backup-manifest.json`

Restore `runtime.sqlite` and `.install-secret` together. Encrypted runtime state cannot be recovered if `.install-secret` is missing or mismatched.

## Service Recommendation

Production should run the API under an OS service manager:

- Windows: Windows Service named `VerifoneCommanderShreCstoresku`.
- Linux: `systemd` service named `verifone-commander-shre-cstoresku`.
- macOS: `launchd` agent named `verifone-commander-shre-cstoresku`.

The update scripts already prefer the service path when the service exists.
