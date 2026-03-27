# Verifone Edge Relay -- Installation Guide

## System Requirements

| Requirement | Minimum |
|-------------|---------|
| **OS** | Windows 10+, macOS 12 (Monterey)+, Ubuntu 20.04+ / Debian 11+ |
| **RAM** | 2 GB available |
| **Disk** | 1 GB free space |
| **Runtime** | Node.js 20+ (not required if using standalone binary) |
| **Network** | LAN access to Verifone Commander (default: 192.168.31.11) |
| **Browser** | Any modern browser for the admin UI (localhost:18464) |

The Edge Relay runs as a background service. It does not require a dedicated server -- any always-on computer on the same LAN as the Commander will work (back-office PC, register terminal, mini PC, etc.).

---

## Windows Installation

### 1. Download the installer

Download `VerifoneEdgeRelay-Setup.exe` from your Shre AI dashboard or the download page at [nirtek.net/pos/verifone.html](https://nirtek.net/pos/verifone.html).

### 2. Run the installer

Double-click the `.exe` file. If Windows SmartScreen appears, click **More info** then **Run anyway** -- the binary is signed by Nirlab Inc.

The installer will:
- Install the Edge Relay service to `C:\Program Files\VerifoneEdgeRelay\`
- Create a Windows Service (`VerifoneEdgeRelay`) set to start automatically
- Create log and data directories under `C:\ProgramData\VerifoneEdgeRelay\`
- Open the setup wizard in your default browser

### 3. Complete the setup wizard

See [Setup Wizard Walkthrough](#setup-wizard-walkthrough) below.

### 4. Verify

Open `http://localhost:18464/status.html` in your browser. You should see a green "Connected" status.

---

## macOS Installation

### 1. Install via terminal

```bash
curl -fsSL https://nirtek.net/install/verifone-edge-relay.sh | bash
```

This script will:
- Download the latest Edge Relay binary to `~/.local/bin/verifone-edge-relay`
- Install a LaunchAgent (`ai.shre.verifone-edge-relay.plist`) for auto-start
- Create data directories under `~/Library/Application Support/VerifoneEdgeRelay/`
- Load the LaunchAgent immediately

### 2. Complete the setup wizard

The installer opens `http://localhost:18464` automatically. If it does not, open it manually.

See [Setup Wizard Walkthrough](#setup-wizard-walkthrough) below.

### 3. Managing the service

```bash
# Stop the relay
launchctl unload ~/Library/LaunchAgents/ai.shre.verifone-edge-relay.plist

# Start the relay
launchctl load ~/Library/LaunchAgents/ai.shre.verifone-edge-relay.plist

# View logs
tail -f ~/Library/Application\ Support/VerifoneEdgeRelay/logs/relay.log
```

---

## Linux Installation

### 1. Install via terminal

```bash
curl -fsSL https://nirtek.net/install/verifone-edge-relay.sh | bash
```

This script will:
- Download the latest Edge Relay binary to `/usr/local/bin/verifone-edge-relay`
- Create a systemd service (`verifone-edge-relay.service`)
- Create data directories under `/var/lib/verifone-edge-relay/`
- Enable and start the service

### 2. Complete the setup wizard

Open `http://localhost:18464` in your browser.

See [Setup Wizard Walkthrough](#setup-wizard-walkthrough) below.

### 3. Managing the service

```bash
# Check status
sudo systemctl status verifone-edge-relay

# Stop
sudo systemctl stop verifone-edge-relay

# Start
sudo systemctl start verifone-edge-relay

# View logs
journalctl -u verifone-edge-relay -f
```

---

## Setup Wizard Walkthrough

The setup wizard runs at `http://localhost:18464` and walks you through four steps.

### Step 1: Login

Enter your Shre AI credentials to authenticate the relay. If you have not created an account yet, visit [shreai.com](https://nirtek.net/signup.html) or register through MIB007.

Default credentials (for initial setup):
- **Username:** `rapidnir`
- **Password:** `rapid@nir`

### Step 2: Commander Connection

Configure the connection to your Verifone Commander:

| Field | Default | Description |
|-------|---------|-------------|
| **Commander IP** | `192.168.31.11` | The LAN IP address of your Commander device |
| **Commander Port** | `443` | HTTPS port (rarely needs changing) |
| **Username** | `rapidnir` | Commander admin username |
| **Password** | `rapid@nir` | Commander admin password |

Click **Test Connection** to verify the relay can reach the Commander. A green checkmark confirms connectivity.

If the connection test fails, see [Troubleshooting](#troubleshooting) below.

### Step 3: Data Sharing Tiers

Select which data tiers the relay should sync:

| Tier | Data Included | Description |
|------|---------------|-------------|
| **Tier 1** | Heartbeat, device status, software version | Basic health monitoring (recommended minimum) |
| **Tier 2** | Transaction summaries, department totals, shift reports | Aggregated business data for analytics |
| **Tier 3** | Line-item transactions, PLU data, fuel data | Full transaction detail for deep analytics |

You can change tiers at any time from the admin dashboard.

### Step 4: Confirm

Review your configuration and click **Activate Relay**. The relay will:
1. Encrypt and store your Commander credentials in the local vault
2. Establish the first connection to your Commander
3. Register with the Shre AI cloud
4. Begin the initial data sync

---

## Verifying Installation

After setup, verify everything is working:

1. **Status page:** Open `http://localhost:18464/status.html` -- all indicators should be green
2. **Commander connection:** The status page shows "Commander: Connected" with the last sync time
3. **Cloud uplink:** The status page shows "Cloud: Connected" with the uplink status
4. **Logs:** Check for errors in the log output (see platform-specific log paths above)

You can also verify from the command line:

```bash
curl -s http://localhost:18464/api/status | jq .
```

Expected response:

```json
{
  "status": "healthy",
  "commander": { "connected": true, "lastSync": "2026-03-25T10:30:00Z" },
  "cloud": { "connected": true, "uplinkStatus": "active" },
  "version": "1.0.0"
}
```

---

## Troubleshooting

### Firewall blocking Commander connection

The relay needs to reach the Commander over HTTPS (port 443) on the local network.

- **Windows:** Open Windows Firewall, add an outbound rule allowing TCP 443 to `192.168.31.11` (or your Commander IP)
- **macOS:** macOS does not block outbound connections by default. If you use a third-party firewall (Little Snitch, Lulu), allow `verifone-edge-relay` to access the LAN
- **Linux:** Check `iptables` or `ufw` rules: `sudo ufw allow out to 192.168.31.11 port 443`

### Commander not reachable

1. Confirm the Commander is powered on and connected to the same LAN
2. Verify the IP address: try `ping 192.168.31.11` from the same computer
3. If the Commander uses a different IP, update it in the admin dashboard at `http://localhost:18464` under Settings
4. Some Commander models use port 8080 instead of 443 -- check your Commander documentation

### Self-signed certificate errors

Verifone Commander devices use self-signed TLS certificates. The Edge Relay accepts these by default. If you see certificate errors:

1. Verify you are connecting to the correct IP (not a rogue device)
2. Check the admin dashboard -- the relay shows the Commander certificate fingerprint on first connection
3. If the fingerprint changed unexpectedly, this may indicate a security issue. Contact support.

### Admin UI not loading

If `http://localhost:18464` does not load:

1. Verify the service is running (see platform-specific commands above)
2. Check that port 18464 is not in use by another application: `lsof -i :18464` (macOS/Linux) or `netstat -ano | findstr 18464` (Windows)
3. Check the logs for startup errors

### Relay not syncing data

1. Open the status page and check both Commander and Cloud connection status
2. If Commander shows disconnected, re-run the connection test from Settings
3. If Cloud shows disconnected, verify your internet connection and that your Shre AI account is active
4. Check logs for specific error messages

---

## Uninstalling

### Windows

Use **Add or Remove Programs** in Windows Settings, or run the uninstaller from `C:\Program Files\VerifoneEdgeRelay\uninstall.exe`.

### macOS

```bash
launchctl unload ~/Library/LaunchAgents/ai.shre.verifone-edge-relay.plist
rm ~/Library/LaunchAgents/ai.shre.verifone-edge-relay.plist
rm ~/.local/bin/verifone-edge-relay
rm -rf ~/Library/Application\ Support/VerifoneEdgeRelay/
```

### Linux

```bash
sudo systemctl stop verifone-edge-relay
sudo systemctl disable verifone-edge-relay
sudo rm /etc/systemd/system/verifone-edge-relay.service
sudo rm /usr/local/bin/verifone-edge-relay
sudo rm -rf /var/lib/verifone-edge-relay/
sudo systemctl daemon-reload
```

---

## Next Steps

- [Onboarding Guide](ONBOARDING.md) -- post-installation setup and verification
- [Knowledge Base](KNOWLEDGE-BASE.md) -- architecture, security, and advanced topics
- [Support](SUPPORT.md) -- FAQ and troubleshooting
