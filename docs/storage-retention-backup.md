# Storage, Retention, And Backup

The app is local-first, so runtime data must survive updates and must not fill the store PC disk. Operators can configure how long cache, activity logs, diagnostics, queue history, usage records, chat audit, and sales snapshots are preserved.

## Runtime Location

```text
Windows: %USERPROFILE%\.verifone-shre-cstoresku
macOS/Linux: ~/.verifone-shre-cstoresku
Database: runtime.sqlite
Secret: .install-secret
```

`runtime.sqlite` contains encrypted JSON payloads. `.install-secret` is required to decrypt those payloads on restore. Back up both together.

## Dashboard Settings

Open `Settings > Storage, Backup & Retention`.

Retention choices:

- 7 days
- 14 days
- 1 month
- 2 months
- 3 months
- 6 months
- 1 year
- Custom days from 1 to 3650

The selected retention applies to activity logs, resolved error log rows, diagnostics bundles, chat audit, reported usage records, completed/failed queue rows, and sales snapshots. Pending queue items and open error log rows are not deleted by retention cleanup.

## Backup Targets

Implemented now:

- Local backup folder, defaulting to `~/VerifoneCommanderBackups`.

Reserved for cloud/archive:

- Shre Platform / Synology.

When Shre Platform/Synology is selected, the local policy records the intent and dashboard status. The actual remote upload should be wired to the Shre storage service once the beta/prod cloud endpoint is available. Until then, use local backup plus external OS/cloud backup.

## API

```http
GET  /api/storage/policy
POST /api/storage/policy
GET  /api/storage/analysis
POST /api/storage/backup
POST /api/storage/retention/apply
```

Example policy:

```json
{
  "retentionDays": 45,
  "backupEnabled": true,
  "backupTarget": "both",
  "localBackupPath": "C:\\VerifoneCommanderBackups",
  "shrePlatformSynologyEnabled": true
}
```

## Disk Forecasting

`GET /api/storage/analysis` calculates current runtime size, free disk bytes, observed data age, table row counts, encrypted payload bytes by table, projected retained runtime size, recommended minimum free space, and risk level.

Sizing rule:

```text
recommended free space = max(2 GB, projected retained runtime size * 3)
```

This keeps room for SQLite WAL files, diagnostics bundles, temporary backup creation, and operating system stability.

## Backup Rules

1. Keep the backup folder outside the protected runtime folder.
2. Keep backups on a different disk, NAS, Synology share, or managed cloud folder when available.
3. Back up `runtime.sqlite` and `.install-secret` together.
4. Do not include Verifone passwords, CStoreSKU keys, Shre activation tokens, or signing secrets in support tickets.
5. Do not delete the runtime folder to make space. Change retention, create backup, then apply retention cleanup.

## Restore Rule

Restore `runtime.sqlite` and `.install-secret` into the same runtime folder. If `.install-secret` is missing or mismatched, encrypted runtime state cannot be decrypted.
