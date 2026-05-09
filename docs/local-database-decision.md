# Local Database Decision

## Recommendation

Use SQLite for the local store install now. Do not add local Postgres yet.

## Why SQLite Fits This Local Connector

SQLite is the right default because:

- One file: `runtime.sqlite`.
- No database server to install, patch, start, or repair.
- Works well on Windows, macOS, Linux, and ARM64.
- Easy backup and diagnostics.
- Good fit for one store machine with one local API and a few worker processes.
- Lower support burden for convenience-store deployments.

The current API uses SQLite with WAL enabled:

```text
runtime.sqlite
runtime.sqlite-wal
runtime.sqlite-shm
```

## When To Add Postgres

Add local Postgres only if we hit one of these needs:

- Multiple local apps writing heavily at the same time.
- Large local analytics datasets.
- Multi-store aggregation on the same machine.
- Complex reporting that SQLite cannot handle comfortably.
- Need for server-side roles, row-level security, or remote SQL clients.
- Queue volume high enough that SQLite write contention becomes measurable.

## Upgrade And Version Persistence

Application updates must not delete the local runtime directory. The local database is stored outside the repo/install package:

```text
Windows: %USERPROFILE%\.verifone-shre-cstoresku\runtime.sqlite
macOS/Linux: ~/.verifone-shre-cstoresku/runtime.sqlite
```

When a new app version is installed or pulled from GitHub, the app code can change, but the local runtime database remains in place unless the user or installer explicitly removes that runtime directory. Stored profile data, Verifone connection state, CStoreSKU key state, queue items, sales snapshots, activity logs, diagnostics bundles, add-on install state, and heartbeat/sync state are designed to persist across app updates.

Installer and release scripts should treat the runtime directory as customer data:

- Do not overwrite or delete `runtime.sqlite`.
- Run migrations in place when schema changes are added.
- Keep backup/export tooling before any destructive maintenance action.
- Only clear runtime data through an explicit support/admin reset workflow.

## Runtime Protection Guard

Installer/update scripts must run the runtime guard before making changes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/protect-runtime.ps1 -MarkProtected -Assert
```

```sh
./scripts/protect-runtime.sh mark
```

The guard creates a `.runtime-protected` marker in the runtime directory and fails destructive reset unless the support/admin override is explicit:

```powershell
$env:ALLOW_VERIFONE_RUNTIME_RESET="I_UNDERSTAND_DELETE_LOCAL_DATA"
powershell -ExecutionPolicy Bypass -File scripts/protect-runtime.ps1 -AllowReset
```

```sh
ALLOW_VERIFONE_RUNTIME_RESET=I_UNDERSTAND_DELETE_LOCAL_DATA ./scripts/protect-runtime.sh allow-reset
```

This is an installer safety lock, not a replacement for OS permissions. A local machine administrator can still manually remove files, but our update path must not delete the runtime folder by default.

## Recommended Future Split

Keep this default:

```text
single-store install -> SQLite
```

Offer this as an advanced deployment:

```text
multi-store / heavy analytics install -> Postgres
```

## Current Position

SQLite is sufficient for:

- Profile and onboarding.
- Verifone connection status.
- Password expiration status.
- Offline queue.
- Activity logs.
- Chat audit.
- Diagnostics bundles.
- Connector activation state.

Postgres is not needed for the current local-first phase.
