# Verifone Edge Relay -- Onboarding Guide

This guide walks you through first-time setup after installation. If you have not installed the Edge Relay yet, start with the [Installation Guide](INSTALLATION-GUIDE.md).

---

## Pre-Requisites Checklist

Before you begin, confirm the following:

- [ ] **Shre AI account** -- You have an active Shre AI account. If not, create one at [nirtek.net/signup.html](https://nirtek.net/signup.html) or through MIB007.
- [ ] **Commander IP address** -- You know the IP address of your Verifone Commander. The default is `192.168.31.11`. You can find this on the Commander's network settings screen or from your network administrator.
- [ ] **Commander credentials** -- You have admin login credentials for the Commander. Defaults: username `rapidnir`, password `rapid@nir`.
- [ ] **Same LAN** -- The computer running the Edge Relay is on the same local network as the Commander. Verify by pinging the Commander IP from the relay computer.
- [ ] **Edge Relay installed** -- The Edge Relay is installed and the service is running. Confirm by opening `http://localhost:18464` in your browser.

---

## Step-by-Step Onboarding

### Step 1: Log In

Open `http://localhost:18464` in your browser. The setup wizard appears automatically on first run.

1. Enter your Shre AI credentials:
   - **Username:** `rapidnir`
   - **Password:** `rapid@nir`
2. Click **Sign In**
3. The relay verifies your account with the Shre AI cloud and retrieves your workspace configuration

If you see an authentication error, verify your credentials at [nirtek.net](https://nirtek.net) first.

### Step 2: Connect to Commander

Configure the connection to your Verifone Commander:

1. **Commander IP Address** -- Pre-filled with `192.168.31.11`. Change this if your Commander uses a different IP.
2. **Commander Port** -- Pre-filled with `443`. Change only if your Commander uses a non-standard port.
3. **Commander Username** -- Enter `rapidnir` (or your Commander admin username).
4. **Commander Password** -- Enter `rapid@nir` (or your Commander admin password).
5. Click **Test Connection**

The relay will attempt to connect to the Commander and verify credentials. You should see:

- Green checkmark: "Commander reachable, credentials valid"

If the test fails:
- Verify the IP address is correct
- Ensure the relay computer can reach the Commander (`ping 192.168.31.11`)
- Check that the Commander is powered on and fully booted
- See [Troubleshooting](INSTALLATION-GUIDE.md#troubleshooting) for more help

### Step 3: Select Data Tiers

Choose what data the relay collects and syncs:

| Tier | What It Includes | Best For |
|------|-----------------|----------|
| **Tier 1** | Device health, heartbeat, software versions | Basic monitoring only |
| **Tier 2** | + Transaction summaries, department totals, shift reports | Most stores (recommended) |
| **Tier 3** | + Line-item transactions, PLU data, fuel data | Full AI analytics |

Select your preferred tier. You can upgrade or downgrade at any time from the admin dashboard. When in doubt, start with **Tier 2** -- it provides solid analytics without the bandwidth of full line-item data.

### Step 4: Confirm and Activate

Review your configuration:

```
Account:     yourname@example.com
Commander:   192.168.31.11:443
Data Tier:   Tier 2 (Business Metrics)
```

Click **Activate Relay**. The relay will:

1. Encrypt your Commander credentials and store them in the local vault
2. Register this relay with your Shre AI workspace
3. Initiate the first data sync with the Commander
4. Establish the cloud uplink

The wizard redirects you to the status dashboard when complete.

---

## Post-Setup Verification

After completing the wizard, verify everything is working:

### Status Dashboard

Open `http://localhost:18464/status.html` and confirm:

| Indicator | Expected State |
|-----------|---------------|
| Relay Status | Running |
| Commander | Connected |
| Cloud Uplink | Active |
| Last Sync | Recent timestamp (within last 5 minutes) |
| Data Tier | Your selected tier |
| Vault | Sealed |

### Command-Line Check

```bash
curl -s http://localhost:18464/api/status | jq .
```

All fields should show healthy/connected states.

### First Data

Within 5 minutes of activation, you should see:
- Tier 1: Commander health data appearing in your Shre AI dashboard
- Tier 2: First transaction summaries after the next Commander reporting cycle
- Tier 3: Individual transactions flowing within 60 seconds

---

## Adding Additional Commander Sites

If you operate multiple stores, each with its own Commander, you can register additional sites.

### From the Admin Dashboard

1. Open `http://localhost:18464`
2. Navigate to **Settings > Sites**
3. Click **Add Site**
4. Enter the new Commander's IP address, port, and credentials
5. Click **Test Connection**, then **Save**

### Important Notes

- Each Commander site requires a separate Edge Relay instance
- If your stores are on separate networks, install the Edge Relay on a computer at each location
- All relay instances connect to the same Shre AI workspace
- Multi-site analytics are aggregated in your Shre AI dashboard

### Multi-Site Deployment

For multi-location operators:

```
Store A: Commander A <-> Edge Relay A <-> Shre AI Cloud
Store B: Commander B <-> Edge Relay B <-> Shre AI Cloud
Store C: Commander C <-> Edge Relay C <-> Shre AI Cloud
                                              |
                                     Unified Dashboard
```

Each relay runs independently. If one store loses internet, the others continue unaffected.

---

## Connecting to AROS

If your organization uses AROS (Agentic Retail Operating System), the Edge Relay integrates automatically.

### Auto-Detection

When you log into the Edge Relay with your Shre AI account, AROS detects the relay and adds the Commander as a connected data source. No additional configuration is needed.

### What AROS Sees

Once connected, AROS can:
- Pull real-time sales data from the Commander via the relay
- Include Commander transaction data in cross-POS analytics
- Run AI agents against your Verifone data alongside other POS sources
- Display Commander health status in the AROS operations dashboard

### Verifying AROS Connection

1. Log into AROS (via MIB007 or your AROS dashboard)
2. Navigate to **Data Sources**
3. Your Commander should appear as "Verifone Commander -- [Store Name]" with a "Connected" status
4. Click the source to view sync details

If the Commander does not appear in AROS within 10 minutes of relay activation, verify that:
- The relay is cloud-connected (check status page)
- Your Shre AI account has AROS access
- The relay and AROS are in the same workspace

---

## First Sync -- What to Expect

### Timeline

| Time After Activation | What Happens |
|----------------------|--------------|
| 0-30 seconds | Relay connects to Commander, retrieves device info |
| 30s - 2 minutes | Tier 1 health data syncs to cloud |
| 2-5 minutes | Tier 2 summary data begins flowing (if selected) |
| 5-10 minutes | Dashboard widgets start populating |
| 10-30 minutes | Tier 3 historical backfill begins (if selected) |
| 1-4 hours | Full historical backfill completes (volume-dependent) |

### Dashboard Population

Your Shre AI dashboard will show:

1. **Commander Health widget** -- appears immediately with device status
2. **Sales Summary cards** -- appear within 5-10 minutes (Tier 2+)
3. **Transaction Feed** -- appears within 5 minutes (Tier 3)
4. **Trend Charts** -- populate over the first hour as data accumulates
5. **AI Insights** -- begin generating after 4+ hours of data collection

### Initial Data Volume

The first sync may transfer more data than subsequent syncs as the relay pulls recent historical data. Expect:

- Tier 1: Less than 1 MB
- Tier 2: 5-50 MB depending on transaction history depth
- Tier 3: 50-500 MB depending on store volume and history

Subsequent syncs are incremental and much smaller.

---

## Next Steps

- Explore the admin dashboard at `http://localhost:18464` to familiarize yourself with the interface
- Review the [Knowledge Base](KNOWLEDGE-BASE.md) for architecture details and security information
- Check the [Support](SUPPORT.md) page if you run into issues
- Visit your Shre AI dashboard to see data flowing from your Commander

---

## Related Documentation

- [Installation Guide](INSTALLATION-GUIDE.md) -- platform-specific setup
- [Knowledge Base](KNOWLEDGE-BASE.md) -- architecture, security, and advanced topics
- [Support](SUPPORT.md) -- FAQ and troubleshooting
- [Developer Documentation](DEVELOPER.md) -- API reference
