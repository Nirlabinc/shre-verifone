# Verifone Edge Relay -- Knowledge Base

## Architecture Overview

The Edge Relay sits between your Verifone Commander (on the store LAN) and the Shre AI cloud. It acts as a secure bridge, pulling data from the Commander and forwarding it to the cloud for analytics and AI processing.

```
Store LAN                          Internet
+------------------+     +-------------------+     +------------------+
|                  |     |                   |     |                  |
|   Verifone       | LAN |   Edge Relay      | TLS |   Shre AI        |
|   Commander      |<--->|   (store PC)      |<--->|   Cloud          |
|                  |     |                   |     |                  |
|  192.168.31.11   |     |  localhost:18464  |     |  api.nirtek.net  |
|  (HTTPS/443)     |     |  (admin UI)       |     |                  |
+------------------+     +-------------------+     +------------------+
                               |
                               |  SQLite DB
                               |  AES-256 Vault
                               |  WAL Buffer
                               |  Audit Log
```

**Data flow:**

1. The Edge Relay polls the Commander at configurable intervals over HTTPS on the LAN
2. Collected data is stored locally in SQLite and the WAL buffer
3. Data is compressed and transmitted to Shre AI cloud over TLS 1.3
4. The cloud processes data and returns commands (password rotations, config updates) via the downlink channel

**Key design principles:**

- The Commander never needs to reach the internet
- The relay never exposes any ports to the LAN (admin UI is localhost-only)
- All credentials are encrypted at rest
- The relay operates autonomously during internet outages

---

## Data Tiers Explained

Data collection is organized into three tiers. Each tier includes everything from the tiers below it.

### Tier 1 -- Health Monitoring

| Data Point | Frequency | Description |
|------------|-----------|-------------|
| Heartbeat | Every 60s | Commander reachability check |
| Device status | Every 5m | Hardware health, disk space, memory |
| Software version | Every 1h | Firmware and application versions |
| Certificate expiry | Every 6h | TLS certificate status |
| Service status | Every 5m | Running services and their states |

Use case: Basic uptime monitoring and alerting. Recommended for all deployments.

### Tier 2 -- Business Metrics

Includes all Tier 1 data, plus:

| Data Point | Frequency | Description |
|------------|-----------|-------------|
| Transaction summaries | Every 5m | Totals by tender type, count, average |
| Department totals | Every 15m | Sales by department |
| Shift reports | End of shift | Cashier shift summaries |
| Hourly sales | Every 1h | Hourly aggregated revenue |
| Fuel dispensing totals | Every 15m | Gallons and revenue by grade (if applicable) |

Use case: Dashboard analytics, trend analysis, and business intelligence. Recommended for most stores.

### Tier 3 -- Full Transaction Detail

Includes all Tier 1 and Tier 2 data, plus:

| Data Point | Frequency | Description |
|------------|-----------|-------------|
| Line-item transactions | Near real-time | Individual items within each transaction |
| PLU data | Every 1h | Price look-up table and item catalog |
| Fuel transaction detail | Near real-time | Per-dispenser, per-transaction fuel data |
| Loyalty/reward data | Near real-time | Points, discounts, promotions applied |
| Void/refund detail | Near real-time | Void and refund line items |

Use case: Deep analytics, shrink detection, item-level insights, AI-driven recommendations. Recommended for stores wanting full Shre AI capabilities.

---

## Security Model

### Credential Vault

All sensitive data (Commander credentials, API keys, cloud tokens) is stored in a local encrypted vault.

- **Encryption:** AES-256-GCM with a 256-bit key derived from the relay's unique device identity
- **Key derivation:** PBKDF2 with 600,000 iterations + device-specific salt
- **Storage:** Single encrypted file on disk; decrypted only in memory when needed
- **Access:** Only the relay process can read the vault; no other application or user can access the decrypted contents

Credentials are never written to logs, environment variables, or configuration files in plaintext.

### HMAC Audit Chain

Every security-relevant event is recorded in an append-only audit log with HMAC-SHA256 chaining:

- Each log entry includes a hash of the previous entry, creating a tamper-evident chain
- If any entry is modified or deleted, the chain breaks and the relay generates a security alert
- Audited events include: login attempts, credential access, configuration changes, password rotations, connection state changes

The audit log is stored locally and optionally replicated to the cloud for long-term retention.

### Localhost-Only Admin UI

The admin interface at `http://localhost:18464` binds exclusively to `127.0.0.1`. This means:

- Only users physically at the relay computer (or with SSH/RDP access) can reach the admin UI
- No network traffic from other devices on the LAN can reach the admin interface
- No port forwarding or firewall rules can expose it unintentionally

### Activity Logging

All relay activity is logged with structured JSON entries:

```json
{
  "timestamp": "2026-03-25T10:30:00.000Z",
  "level": "info",
  "module": "commander-sync",
  "event": "sync_complete",
  "tier": 2,
  "records": 47,
  "durationMs": 1230
}
```

Logs are rotated daily and retained for 7 days locally. Security events are retained for 90 days.

---

## Password Rotation

The Edge Relay manages Commander credentials with an automated rotation lifecycle.

### Lifecycle

| Phase | Timing | Action |
|-------|--------|--------|
| Active | Days 0-60 | Current password in use, no action needed |
| Warning | Day 60 | Alert generated: rotation recommended |
| Auto-rotate | Day 60 | Relay automatically generates a new password and updates Commander |
| Grace period | Days 60-90 | Old password remains valid as fallback |
| Expiry | Day 90 | Old password is invalidated, only new password works |

### How It Works

1. At the 60-day mark, the relay generates a cryptographically random password (32 characters, mixed case + digits + symbols)
2. The relay logs into the Commander with the current password
3. The relay updates the Commander password to the new value
4. The new password is stored in the encrypted vault
5. The old password is kept in the vault for the grace period as a fallback
6. On day 90, the old password entry is securely erased from the vault

### Manual Rotation

You can trigger an immediate rotation from the admin dashboard or command line:

```bash
verifone-edge-relay --rotate-password
```

### Notifications

Password rotation events generate:
- An entry in the audit log
- A notification in the admin dashboard
- A cloud event visible in your Shre AI dashboard (if cloud-connected)

---

## Offline Operation

The Edge Relay is designed to operate independently during internet outages.

### Write-Ahead Log (WAL) Buffer

When the cloud uplink is unavailable:

1. Data continues to be collected from the Commander on schedule
2. All collected data is written to the local WAL buffer (SQLite-backed)
3. The WAL buffer retains up to **7 days** of data
4. When connectivity is restored, the buffer is replayed to the cloud in chronological order
5. Replay is throttled to avoid overwhelming the uplink
6. Successfully replayed entries are removed from the buffer

### Buffer Capacity

| Tier | Estimated Daily Size | 7-Day Capacity |
|------|---------------------|----------------|
| Tier 1 | ~500 KB | ~3.5 MB |
| Tier 2 | ~10 MB | ~70 MB |
| Tier 3 | ~50 MB | ~350 MB |

If the buffer reaches capacity, the oldest data is evicted to make room for new data. A warning is logged when the buffer exceeds 80% capacity.

### Commander Operations During Outage

During an internet outage, the relay continues:
- Heartbeat monitoring
- Data collection at all configured tiers
- Password rotation (if scheduled)
- Local anomaly detection
- Audit logging

The only thing that pauses is cloud uplink transmission.

---

## Auto-Updates

The Edge Relay checks for updates every 4 hours.

### Update Process

1. **Check:** The relay queries `api.nirtek.net/relay/updates` for the latest version
2. **Download:** If a new version is available, the binary is downloaded to a staging area
3. **Verify:** The SHA-256 hash of the downloaded binary is compared against the signed manifest
4. **Apply:** The relay stops, replaces the binary, and restarts
5. **Validate:** After restart, the relay runs a self-check; if it fails, it rolls back automatically

### Rollback

If an update causes the relay to fail its self-check (health endpoint does not respond within 30 seconds):

1. The new binary is moved aside
2. The previous binary is restored
3. The relay restarts with the previous version
4. A rollback event is logged and reported to the cloud

### Update Channels

| Channel | Description |
|---------|-------------|
| `stable` | Production-tested releases (default) |
| `beta` | Early access to upcoming features |

Change the update channel in Settings or via:
```bash
verifone-edge-relay --update-channel beta
```

---

## SecretService Monitoring

The Edge Relay includes an anomaly detection module (SecretService) that monitors the Commander for suspicious activity.

### Detection Rules

| Rule | Description | Severity |
|------|-------------|----------|
| Failed login spike | More than 5 failed logins in 10 minutes | High |
| Off-hours access | Commander admin login outside configured business hours | Medium |
| Config change | Network, firewall, or service configuration modified | Medium |
| Certificate change | TLS certificate fingerprint changed unexpectedly | High |
| New admin user | A new administrator account was created | High |
| Service stopped | A monitored service stopped unexpectedly | Medium |
| Firmware change | Commander firmware version changed | Low |
| Unusual data volume | Transaction volume deviates more than 3 standard deviations from baseline | Medium |

### Alert Routing

When a rule triggers:

1. The event is recorded in the local audit log
2. A notification appears in the admin dashboard
3. If cloud-connected, the event is forwarded to your Shre AI workspace
4. High-severity events are flagged for immediate review

### Configuration

Anomaly detection rules can be customized in the admin dashboard under Settings > Security. You can:

- Enable or disable individual rules
- Adjust thresholds (e.g., change failed login spike from 5 to 10)
- Configure business hours for off-hours detection
- Set up custom notification preferences

---

## Related Documentation

- [Installation Guide](INSTALLATION-GUIDE.md) -- setup and installation
- [Support](SUPPORT.md) -- FAQ and troubleshooting
- [Onboarding Guide](ONBOARDING.md) -- first-time setup walkthrough
- [Developer Documentation](DEVELOPER.md) -- API reference and internals
