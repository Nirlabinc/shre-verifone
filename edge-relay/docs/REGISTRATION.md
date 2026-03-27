# Verifone Edge Relay -- Registration Guide

## Creating a Shre AI Account

Before using the Edge Relay, you need a Shre AI account. There are two ways to create one.

### Option 1: Via MIB007

If you already use MIB007:

1. Open MIB007 at [mib007.nirtek.net](https://mib007.nirtek.net) or your local instance
2. Navigate to **Settings > Account**
3. If you do not have an account, click **Create Account**
4. Enter your email address and set a password
5. Verify your email via the confirmation link

### Option 2: Via shreai.com

1. Visit [nirtek.net/signup.html](https://nirtek.net/signup.html)
2. Enter your name, email, and password
3. Select your organization type (single store, multi-location, or enterprise)
4. Verify your email via the confirmation link
5. Complete the onboarding questionnaire (optional but recommended)

Default credentials for initial setup:
- **Username:** `rapidnir`
- **Password:** `rapid@nir`

You can change these after your first login.

---

## Relay Registration Flow

Once you have a Shre AI account, register your Edge Relay.

### Step 1: Install the Edge Relay

Follow the [Installation Guide](INSTALLATION-GUIDE.md) for your platform. The setup wizard handles registration automatically.

### Step 2: Authenticate

When the setup wizard opens at `http://localhost:18464`, log in with your Shre AI credentials. This step:

1. Verifies your account with the Shre AI cloud
2. Generates a unique relay API key
3. Associates the relay with your workspace

### Step 3: Receive Your Relay API Key

After authentication, the relay receives a unique API key. This key is:

- Generated server-side and transmitted over TLS
- Stored in the local encrypted vault (never shown in plaintext after initial setup)
- Used for all subsequent cloud communication
- Scoped to your workspace -- it cannot access other users' data

You do not need to copy or manage this key manually. The relay handles it automatically.

### Step 4: Complete Setup

Finish the remaining setup wizard steps (Commander connection, data tier selection, activation). See the [Onboarding Guide](ONBOARDING.md) for details.

---

## Multi-Site Registration

If you operate multiple stores, each Commander site needs its own Edge Relay instance.

### Adding a Second Site

1. Install the Edge Relay on a computer at the second store
2. Open the setup wizard at `http://localhost:18464`
3. Log in with the **same** Shre AI credentials
4. The system detects your existing workspace and adds this relay as an additional site
5. Configure the local Commander IP and credentials
6. Activate

### Site Management

After registering multiple sites, manage them from your Shre AI dashboard:

| Action | Where |
|--------|-------|
| View all sites | Shre AI Dashboard > Sites |
| Rename a site | Dashboard > Sites > [Site] > Edit |
| Remove a site | Dashboard > Sites > [Site] > Deactivate |
| View site status | Dashboard > Sites > [Site] > Status |

### Site Naming

During registration, each site is automatically named based on the relay's hostname. You can rename sites from the dashboard for clarity:

- "Store #1 - Main St"
- "Store #2 - Airport Rd"
- "Warehouse - Distribution Center"

### Cross-Site Analytics

With multiple sites registered under the same workspace:

- The Shre AI dashboard aggregates data across all sites
- You can filter analytics by individual site or view combined metrics
- AI insights incorporate data from all connected locations
- Anomaly detection baselines are calculated per-site

---

## Account Linking

### How the Relay Connects to Your Workspace

When you authenticate during setup, the following linking process occurs:

```
1. Relay sends credentials to Shre AI cloud
2. Cloud verifies account and returns workspace ID + relay API key
3. Relay stores API key in encrypted vault
4. Cloud registers relay ID in your workspace
5. All future uplink data is tagged with relay ID and workspace ID
6. Dashboard queries data by workspace ID to show all your relays
```

### Workspace Hierarchy

```
Shre AI Account (you@example.com)
  |
  +-- Workspace (ws-abc123)
       |
       +-- Relay: Store #1 (relay-001)
       |     +-- Commander: 192.168.31.11
       |     +-- Data Tier: 2
       |
       +-- Relay: Store #2 (relay-002)
       |     +-- Commander: 192.168.31.15
       |     +-- Data Tier: 3
       |
       +-- Relay: Store #3 (relay-003)
             +-- Commander: 192.168.31.11
             +-- Data Tier: 1
```

### AROS Integration

If your workspace has AROS enabled, the relay is automatically visible to AROS agents:

- AROS sees each relay as a data source
- Agents can query Commander data through the Shre AI cloud API
- No additional configuration is needed on the relay side
- See [Connecting to AROS](ONBOARDING.md#connecting-to-aros) for details

### MIB007 Integration

The relay also appears in MIB007:

1. Open MIB007
2. Navigate to **Agents > Data Sources**
3. Each registered relay shows with its status and last sync time
4. You can ask Shre about your relay status in chat: "@shre what is the status of my Verifone relays?"

---

## API Key Management

### Viewing Your API Key

For security, the relay API key is only shown once (during initial registration). If you need to verify the key:

- The first 8 characters are visible in the admin dashboard under Settings > API Key
- The full key is stored in the encrypted vault and used automatically

### Revoking an API Key

If you suspect a key has been compromised:

1. Log into your Shre AI dashboard
2. Navigate to **Settings > API Keys**
3. Find the relay and click **Revoke**
4. The relay will disconnect from the cloud immediately
5. Re-run the setup wizard on the relay to generate a new key

### Key Rotation

API keys do not expire automatically, but you can rotate them:

1. From the Shre AI dashboard, click **Rotate** next to the relay
2. The cloud generates a new key and pushes it to the relay via the downlink channel
3. The relay stores the new key and begins using it immediately
4. The old key is invalidated after 60 seconds (grace period for in-flight requests)

---

## Deactivating a Relay

### Temporary Deactivation

If you need to take a relay offline temporarily:

```bash
# Stop the service (data is preserved)
# macOS
launchctl unload ~/Library/LaunchAgents/ai.shre.verifone-edge-relay.plist

# Linux
sudo systemctl stop verifone-edge-relay

# Windows
sc stop VerifoneEdgeRelay
```

The relay will show as "Offline" in your dashboard. When restarted, it resumes from where it left off.

### Permanent Deactivation

To permanently remove a relay:

1. Uninstall the relay software (see [Installation Guide](INSTALLATION-GUIDE.md#uninstalling))
2. In your Shre AI dashboard, navigate to **Sites** and click **Deactivate** on the relay
3. This revokes the API key and removes the relay from your workspace
4. Historical data collected by this relay is retained in your workspace

---

## Related Documentation

- [Installation Guide](INSTALLATION-GUIDE.md) -- platform-specific setup
- [Onboarding Guide](ONBOARDING.md) -- first-time walkthrough after registration
- [Support](SUPPORT.md) -- FAQ and troubleshooting
- [Knowledge Base](KNOWLEDGE-BASE.md) -- architecture and security
