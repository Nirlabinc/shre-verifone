# Verifone Edge Relay -- Developer Documentation

## API Reference

The Edge Relay admin API runs on `localhost:18464`. All endpoints are accessible only from the local machine (bound to `127.0.0.1`).

### Authentication

Most endpoints require authentication via session cookie. Obtain a session by calling `POST /api/auth/login`.

```bash
# Login and store session cookie
curl -c cookies.txt -X POST http://localhost:18464/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "rapidnir", "password": "rapid@nir"}'

# Use session cookie for subsequent requests
curl -b cookies.txt http://localhost:18464/api/status
```

### Status Endpoints

#### GET /api/status

Returns the current relay status. No authentication required.

**Response:**

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime": 86400,
  "commander": {
    "connected": true,
    "ip": "192.168.31.11",
    "port": 443,
    "lastSync": "2026-03-25T10:30:00Z",
    "firmware": "4.2.1",
    "latencyMs": 12
  },
  "cloud": {
    "connected": true,
    "uplinkStatus": "active",
    "lastUplink": "2026-03-25T10:30:05Z",
    "pendingWAL": 0
  },
  "vault": {
    "sealed": true,
    "credentialCount": 2,
    "lastRotation": "2026-02-15T03:00:00Z",
    "nextRotation": "2026-04-16T03:00:00Z"
  },
  "dataTier": 2
}
```

#### GET /health

Minimal health check. Returns `200 OK` with `{"ok": true}` if the service is running.

#### GET /readyz

Readiness check. Returns `200 OK` only when the relay has completed initialization, vault is loaded, and Commander connectivity has been verified at least once.

### Setup Endpoints

These endpoints are used by the setup wizard. They are disabled after initial setup unless the relay is reset.

#### POST /api/setup/auth

Authenticate with Shre AI cloud.

**Request:**

```json
{
  "username": "rapidnir",
  "password": "rapid@nir"
}
```

**Response:**

```json
{
  "authenticated": true,
  "workspace": "ws-abc123",
  "email": "user@example.com"
}
```

#### POST /api/setup/commander

Configure and test Commander connection.

**Request:**

```json
{
  "ip": "192.168.31.11",
  "port": 443,
  "username": "rapidnir",
  "password": "rapid@nir"
}
```

**Response:**

```json
{
  "reachable": true,
  "authenticated": true,
  "firmware": "4.2.1",
  "deviceId": "CMD-001",
  "certFingerprint": "A1:B2:C3:..."
}
```

#### POST /api/setup/tier

Set the data collection tier.

**Request:**

```json
{
  "tier": 2
}
```

**Response:**

```json
{
  "tier": 2,
  "description": "Business Metrics"
}
```

#### POST /api/setup/activate

Finalize setup and activate the relay.

**Response:**

```json
{
  "activated": true,
  "relayId": "relay-xyz789",
  "firstSyncStarted": true
}
```

### Log Endpoints

#### GET /api/logs/relay

Returns recent relay log entries.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `lines` | number | 100 | Number of log lines to return |
| `level` | string | all | Filter by level: `debug`, `info`, `warn`, `error` |
| `since` | ISO 8601 | -- | Return entries after this timestamp |

**Response:**

```json
{
  "entries": [
    {
      "timestamp": "2026-03-25T10:30:00.000Z",
      "level": "info",
      "module": "commander-sync",
      "event": "sync_complete",
      "details": { "tier": 2, "records": 47, "durationMs": 1230 }
    }
  ],
  "total": 1,
  "hasMore": false
}
```

#### GET /api/logs/audit

Returns audit log entries (security events, config changes).

**Query parameters:** Same as `/api/logs/relay`.

#### GET /api/logs/sync

Returns Commander sync log entries.

**Query parameters:** Same as `/api/logs/relay`, plus:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tier` | number | all | Filter by data tier (1, 2, or 3) |

### Settings Endpoints

#### GET /api/settings

Returns current relay settings (credentials are redacted).

**Response:**

```json
{
  "commander": {
    "ip": "192.168.31.11",
    "port": 443,
    "username": "rapidnir"
  },
  "dataTier": 2,
  "updateChannel": "stable",
  "security": {
    "passwordRotationDays": 60,
    "anomalyDetection": true,
    "businessHours": { "start": "06:00", "end": "23:00" }
  },
  "sync": {
    "intervalSeconds": 300,
    "walRetentionDays": 7,
    "compressionEnabled": true
  }
}
```

#### PATCH /api/settings

Update relay settings. Only include fields you want to change.

**Request:**

```json
{
  "dataTier": 3,
  "security": {
    "passwordRotationDays": 30
  },
  "sync": {
    "intervalSeconds": 60
  }
}
```

**Response:** Returns the full updated settings object.

#### POST /api/settings/test-commander

Re-test Commander connectivity with current saved credentials.

**Response:**

```json
{
  "reachable": true,
  "authenticated": true,
  "latencyMs": 15
}
```

#### POST /api/settings/rotate-password

Trigger immediate Commander password rotation.

**Response:**

```json
{
  "rotated": true,
  "previousExpiry": "2026-06-25T00:00:00Z",
  "newExpiry": "2026-06-25T00:00:00Z"
}
```

### Diagnostics Endpoints

#### GET /api/diagnostics

Returns a comprehensive diagnostic report.

**Response:**

```json
{
  "relay": { "version": "1.0.0", "uptime": 86400, "pid": 12345 },
  "system": { "os": "darwin", "arch": "arm64", "nodeVersion": "20.11.0", "totalMemMB": 8192, "freeMemMB": 4096 },
  "commander": { "connected": true, "latencyMs": 12 },
  "cloud": { "connected": true, "latencyMs": 45 },
  "database": { "sizeMB": 12.5, "walEntries": 0, "walSizeMB": 0 },
  "vault": { "sealed": true, "integrity": "valid" }
}
```

#### POST /api/diagnostics/bundle

Generates a support diagnostic bundle (logs + config with redacted credentials + system info).

**Response:** Returns the bundle as a downloadable text file.

---

## Uplink / Downlink Protocol

### Uplink (Relay to Cloud)

The relay sends data to the Shre AI cloud via HTTPS POST requests.

**Endpoint:** `https://api.nirtek.net/relay/v1/uplink`

**Request format:**

```json
{
  "relayId": "relay-xyz789",
  "timestamp": "2026-03-25T10:30:00Z",
  "batch": [
    {
      "type": "health",
      "tier": 1,
      "timestamp": "2026-03-25T10:29:55Z",
      "data": { "...": "..." }
    },
    {
      "type": "transaction_summary",
      "tier": 2,
      "timestamp": "2026-03-25T10:29:58Z",
      "data": { "...": "..." }
    }
  ],
  "sequence": 12345,
  "checksum": "sha256:abc123..."
}
```

**Key fields:**

- `relayId` -- Unique relay identifier assigned during registration
- `batch` -- Array of data records, each tagged with type and tier
- `sequence` -- Monotonically increasing sequence number for ordering and deduplication
- `checksum` -- SHA-256 hash of the batch payload for integrity verification

**Response:**

```json
{
  "accepted": true,
  "sequence": 12345,
  "commands": []
}
```

### Downlink (Cloud to Relay)

The cloud sends commands to the relay via the `commands` array in uplink responses. The relay also polls a dedicated downlink endpoint.

**Endpoint:** `https://api.nirtek.net/relay/v1/downlink`

**Command types:**

| Command | Description |
|---------|-------------|
| `rotate_password` | Trigger immediate password rotation |
| `update_tier` | Change the data collection tier |
| `update_config` | Push new configuration values |
| `force_sync` | Trigger an immediate Commander sync |
| `update_available` | Notify of a pending software update |
| `revoke` | Deactivate the relay (remote wipe) |

**Example command:**

```json
{
  "id": "cmd-abc123",
  "type": "update_tier",
  "payload": { "tier": 3 },
  "issuedAt": "2026-03-25T10:00:00Z",
  "expiresAt": "2026-03-26T10:00:00Z"
}
```

The relay acknowledges commands in the next uplink request.

---

## SQLite Schema Reference

The relay uses SQLite for local data storage, WAL buffering, and metadata.

### Tables

#### relay_config

```sql
CREATE TABLE relay_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Stores runtime configuration (serialized JSON values).

#### commander_health

```sql
CREATE TABLE commander_health (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  status     TEXT NOT NULL,          -- 'healthy', 'degraded', 'unreachable'
  latency_ms INTEGER,
  firmware   TEXT,
  details    TEXT,                   -- JSON blob
  synced     INTEGER DEFAULT 0       -- 0 = pending, 1 = uploaded
);

CREATE INDEX idx_health_timestamp ON commander_health(timestamp);
CREATE INDEX idx_health_synced ON commander_health(synced);
```

#### transaction_summary

```sql
CREATE TABLE transaction_summary (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  total_sales   REAL,
  total_count   INTEGER,
  avg_basket    REAL,
  by_tender     TEXT,                -- JSON: {"cash": 1234.56, "credit": 5678.90}
  by_department TEXT,                -- JSON: {"grocery": 2000, "fuel": 4000}
  synced        INTEGER DEFAULT 0
);

CREATE INDEX idx_txn_summary_timestamp ON transaction_summary(timestamp);
CREATE INDEX idx_txn_summary_synced ON transaction_summary(synced);
```

#### transaction_detail

```sql
CREATE TABLE transaction_detail (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL,
  transaction_id  TEXT NOT NULL,
  register_id     TEXT,
  cashier_id      TEXT,
  items           TEXT,              -- JSON array of line items
  total           REAL,
  tender_type     TEXT,
  void_flag       INTEGER DEFAULT 0,
  refund_flag     INTEGER DEFAULT 0,
  synced          INTEGER DEFAULT 0
);

CREATE INDEX idx_txn_detail_timestamp ON transaction_detail(timestamp);
CREATE INDEX idx_txn_detail_synced ON transaction_detail(synced);
CREATE INDEX idx_txn_detail_txn_id ON transaction_detail(transaction_id);
```

#### wal_buffer

```sql
CREATE TABLE wal_buffer (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence  INTEGER NOT NULL UNIQUE,
  payload   BLOB NOT NULL,           -- Compressed JSON batch
  created   TEXT NOT NULL,
  attempts  INTEGER DEFAULT 0
);

CREATE INDEX idx_wal_sequence ON wal_buffer(sequence);
```

#### audit_log

```sql
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  event      TEXT NOT NULL,
  actor      TEXT,
  details    TEXT,                    -- JSON
  prev_hash  TEXT NOT NULL,          -- HMAC chain
  hash       TEXT NOT NULL
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
```

#### password_history

```sql
CREATE TABLE password_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created         TEXT NOT NULL,
  expires         TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,     -- SHA-256 of encrypted credential
  rotation_reason TEXT,
  active          INTEGER DEFAULT 1
);
```

---

## Building from Source

### Prerequisites

- Node.js 20+
- npm 10+

### Clone and Install

```bash
git clone https://github.com/nirlabinc/shreai.git
cd shreai/shre-verifone/edge-relay
npm install
```

### Development

```bash
# Run in development mode with hot reload
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

### Production Build

```bash
node build/build.mjs
```

This produces:
- `dist/verifone-edge-relay.js` -- bundled Node.js application
- `dist/admin-ui/` -- compiled admin UI static files

### Standalone Binary

To create a standalone binary (no Node.js required on the target machine):

```bash
node build/build.mjs --standalone
```

This uses `pkg` to compile the application into platform-specific executables:
- `dist/verifone-edge-relay-win.exe`
- `dist/verifone-edge-relay-macos`
- `dist/verifone-edge-relay-linux`

### Installer Packaging

```bash
# Windows (NSIS)
node build/build.mjs --installer windows

# macOS (pkg + LaunchAgent)
node build/build.mjs --installer macos

# Linux (deb + systemd)
node build/build.mjs --installer linux
```

---

## Contributing

### Code Structure

```
edge-relay/
  admin-ui/          Admin dashboard (static HTML/JS)
  build/             Build scripts
    build.mjs        Main build script
  docs/              Documentation (this directory)
  installer/         Platform-specific installer resources
  pdk/               Platform Development Kit (shared types)
  src/               Source code
    commander/       Commander communication module
      client.ts      HTTPS client for Commander API
      parser.ts      Response parsers for Commander data formats
      poller.ts      Polling scheduler
    cloud/           Cloud uplink/downlink module
      uplink.ts      Batch uplink sender
      downlink.ts    Command receiver and processor
    db/              Database module
      schema.sql     SQLite schema definitions
      store.ts       Database access layer
      wal.ts         Write-ahead log buffer
    security/        Security module
      vault.ts       AES-256-GCM credential vault
      audit.ts       HMAC audit chain
      rotation.ts    Password rotation lifecycle
      anomaly.ts     SecretService anomaly detection
    server.ts        HTTP server (admin API + UI)
    config.ts        Configuration management
    index.ts         Application entry point
  package.json
```

### Module Architecture

```
+-----------------------------------------------------+
|                   index.ts (entry)                    |
+-----------------------------------------------------+
         |              |              |
    +----v----+   +-----v-----+  +----v----+
    | server  |   | commander |  |  cloud  |
    | .ts     |   | /         |  | /       |
    |         |   | client.ts |  | uplink  |
    | Admin   |   | parser.ts |  | downlink|
    | API +   |   | poller.ts |  |         |
    | Static  |   +-----------+  +---------+
    | UI      |        |              |
    +---------+        v              v
         |        +----------+  +----------+
         |        | db/      |  | security/|
         +------->| store.ts |  | vault.ts |
                  | wal.ts   |  | audit.ts |
                  +----------+  | rotation |
                                | anomaly  |
                                +----------+
```

### Development Guidelines

1. **TypeScript only** -- All source files must be TypeScript
2. **No external dependencies for crypto** -- Use Node.js built-in `crypto` module
3. **SQLite via better-sqlite3** -- Synchronous API, no ORMs
4. **Structured logging** -- All log entries must be JSON with `timestamp`, `level`, `module`, and `event` fields
5. **Audit all security events** -- Any credential access, config change, or anomaly must go through `audit.ts`
6. **Test coverage** -- New features require tests; run `npm test` before submitting
7. **No secrets in code** -- Credentials go in the vault, configuration in SQLite, nothing hardcoded

### Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes with tests
4. Run the test suite: `npm test`
5. Run the linter: `npm run lint`
6. Submit a pull request with a clear description

---

## Related Documentation

- [Installation Guide](INSTALLATION-GUIDE.md) -- end-user setup
- [Knowledge Base](KNOWLEDGE-BASE.md) -- architecture and security details
- [Support](SUPPORT.md) -- troubleshooting
- [Onboarding Guide](ONBOARDING.md) -- first-time walkthrough
- [Registration Guide](REGISTRATION.md) -- account and relay registration
