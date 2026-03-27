# Verifone Edge Relay -- Support

## Frequently Asked Questions

### What is the Verifone Edge Relay?

The Edge Relay is a lightweight application that runs on a computer in your store, on the same local network as your Verifone Commander. It securely bridges the gap between your LAN-only Commander device and the Shre AI cloud, enabling AI-powered analytics, password management, and security monitoring without exposing your Commander to the public internet.

### What data does the Edge Relay collect?

The data collected depends on the tier you select during setup:

- **Tier 1:** Device health, heartbeat, software versions -- basic monitoring only
- **Tier 2:** Transaction summaries, department totals, shift reports -- aggregated business metrics
- **Tier 3:** Line-item transactions, PLU data, fuel data -- full transaction detail

You choose the tier during setup and can change it at any time. No data is collected beyond what your selected tier includes.

### Is my data secure?

Yes. The Edge Relay uses multiple layers of security:

- All credentials are stored in an AES-256-GCM encrypted local vault
- Communication with Shre AI cloud uses TLS 1.3
- The admin UI is accessible only from localhost (127.0.0.1) -- it cannot be reached from other devices on the network
- Every configuration change is logged in a tamper-evident HMAC audit chain
- Commander credentials never leave the local device in plaintext

See the [Knowledge Base](KNOWLEDGE-BASE.md) for a detailed security overview.

### How do I update the Edge Relay?

The Edge Relay checks for updates automatically every 4 hours. When an update is available:

1. The new version is downloaded and its SHA-256 hash is verified
2. The update is applied during the next low-activity window
3. If the update fails, the relay automatically rolls back to the previous version

You can also trigger a manual update check from the admin dashboard under Settings, or from the command line:

```bash
# macOS / Linux
verifone-edge-relay --check-update

# Windows (from installation directory)
VerifoneEdgeRelay.exe --check-update
```

### How do I uninstall the Edge Relay?

See the [Uninstalling section](INSTALLATION-GUIDE.md#uninstalling) in the Installation Guide for platform-specific instructions.

### Does the relay work if my internet goes down?

Yes. The Edge Relay continues to collect data from the Commander and stores it in a local write-ahead log (WAL) buffer. When internet connectivity is restored, all buffered data is automatically replayed to the cloud. The buffer retains up to 7 days of data.

### How much bandwidth does the relay use?

Minimal. Tier 1 data uses less than 1 MB/day. Tier 2 adds approximately 5-10 MB/day depending on transaction volume. Tier 3 can range from 10-50 MB/day for busy stores. All data is compressed before transmission.

---

## Common Issues and Solutions

### The relay cannot connect to the Commander

**Symptoms:** Status page shows "Commander: Disconnected" or the connection test fails during setup.

**Solutions:**
1. Verify the Commander IP address -- the default is `192.168.31.11` but your network may differ
2. Ping the Commander from the relay computer: `ping 192.168.31.11`
3. Confirm the relay computer and Commander are on the same LAN/VLAN
4. Check that no firewall is blocking port 443 (or 8080) to the Commander IP
5. Try accessing the Commander admin panel directly in a browser: `https://192.168.31.11`
6. If the Commander was recently rebooted, wait 2-3 minutes for it to fully start

### The relay is connected but not syncing

**Symptoms:** Commander shows "Connected" but "Last Sync" timestamp is stale.

**Solutions:**
1. Check the selected data tier -- Tier 1 syncs less frequently (every 5 minutes) than Tier 3 (every 60 seconds)
2. Review the logs for specific error messages
3. Restart the relay service (see platform-specific commands in the Installation Guide)
4. If the Commander firmware was recently updated, the relay may need a credentials re-entry

### Cloud uplink disconnected

**Symptoms:** Status page shows "Cloud: Disconnected".

**Solutions:**
1. Verify internet connectivity from the relay computer
2. Check that your Shre AI account is active and the relay API key has not been revoked
3. If you are behind a corporate proxy, configure the proxy in Settings
4. Check if `api.nirtek.net` is reachable: `curl -s https://api.nirtek.net/health`

### Admin UI shows a blank page

**Solutions:**
1. Clear your browser cache and reload
2. Try a different browser
3. Verify the relay service is running
4. Check that nothing else is using port 18464

### High CPU or memory usage

**Solutions:**
1. Check the logs for error loops (repeated failed connection attempts can cause CPU spikes)
2. If the WAL buffer is very large (after extended offline period), CPU may spike during replay -- this is temporary
3. Restart the relay service to clear any stuck state
4. If the issue persists, contact support with the diagnostic bundle (see below)

---

## Viewing Logs

### Windows

Logs are stored at:
```
C:\ProgramData\VerifoneEdgeRelay\logs\
```

Files:
- `relay.log` -- main application log (rotated daily, 7 days retained)
- `audit.log` -- security and configuration change audit trail
- `sync.log` -- Commander sync activity

To view in PowerShell:
```powershell
Get-Content "C:\ProgramData\VerifoneEdgeRelay\logs\relay.log" -Tail 50 -Wait
```

### macOS

Logs are stored at:
```
~/Library/Application Support/VerifoneEdgeRelay/logs/
```

To view:
```bash
tail -f ~/Library/Application\ Support/VerifoneEdgeRelay/logs/relay.log
```

### Linux

Logs are stored at:
```
/var/lib/verifone-edge-relay/logs/
```

To view via journalctl (recommended):
```bash
journalctl -u verifone-edge-relay -f
```

To view log files directly:
```bash
tail -f /var/lib/verifone-edge-relay/logs/relay.log
```

### Generating a Diagnostic Bundle

To create a support bundle containing logs, configuration (with credentials redacted), and system information:

```bash
# macOS / Linux
verifone-edge-relay --diagnostics > diagnostic-bundle.txt

# Windows
VerifoneEdgeRelay.exe --diagnostics > diagnostic-bundle.txt
```

Attach this file when contacting support.

---

## Contacting Support

### Email

Send an email to **support@nirtek.net** with:
- Your Shre AI account email
- The relay version (shown on the status page or via `verifone-edge-relay --version`)
- A description of the issue
- The diagnostic bundle (see above)

### In-App

From the admin dashboard at `http://localhost:18464`, click **Help** in the navigation bar and select **Contact Support**. This pre-fills your relay information.

### MIB007

If you use MIB007, open a support conversation:
```
@shre I need help with my Verifone Edge Relay
```

Shre will route you to the appropriate support agent.

### Response Times

| Priority | Description | Target Response |
|----------|-------------|-----------------|
| Critical | Relay down, no data sync | 4 hours |
| High | Partial functionality, degraded sync | 1 business day |
| Normal | Configuration questions, feature requests | 2 business days |
| Low | General inquiries | 5 business days |

---

## Resetting the Relay

If you need to start fresh without reinstalling:

### Soft Reset (keeps installation, clears configuration)

```bash
# macOS / Linux
verifone-edge-relay --reset

# Windows
VerifoneEdgeRelay.exe --reset
```

This clears the local vault, configuration, and WAL buffer. The setup wizard will reappear at `http://localhost:18464`.

### Full Reinstall

1. Uninstall the relay (see [Installation Guide](INSTALLATION-GUIDE.md#uninstalling))
2. Delete remaining data directories (paths listed above)
3. Reinstall following the [Installation Guide](INSTALLATION-GUIDE.md)

---

## Related Documentation

- [Installation Guide](INSTALLATION-GUIDE.md) -- setup and installation
- [Knowledge Base](KNOWLEDGE-BASE.md) -- architecture and deep dives
- [Onboarding Guide](ONBOARDING.md) -- first-time setup walkthrough
- [Developer Documentation](DEVELOPER.md) -- API reference and internals
