# One-Click Pilot Installer

The pilot installer is designed for support-led deployment. The store operator does not need to complete setup locally. Support runs one command, Cloudflare Access exposes the portal, and the operator receives the standalone chat URL.

## Installed Components

- Git, Node.js, npm, and cloudflared when the platform package manager supports it.
- Verifone Commander Shre CStoreSKU app from GitHub.
- Local encrypted SQLite runtime under the app runtime folder.
- Runtime protection marker to prevent accidental data deletion.
- Local dashboard API on port `5480`.
- Cloudflare tunnel ingress for portal, dashboard, chat, and Verifone ConfigClient.
- Remote access registration inside the local dashboard API.

## Windows

Run PowerShell as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-oneclick.ps1 `
  -TunnelName store001-verifone-commander `
  -PortalHostname store001-portal.example.com `
  -DashboardHostname store001-dashboard.example.com `
  -ChatHostname store001-chat.example.com `
  -VerifoneHostname store001-verifone.example.com `
  -TunnelToken "<cloudflare-tunnel-token>" `
  -InstallCloudflareService
```

## Linux And macOS

```bash
export TUNNEL_NAME=store001-verifone-commander
export PORTAL_HOSTNAME=store001-portal.example.com
export DASHBOARD_HOSTNAME=store001-dashboard.example.com
export CHAT_HOSTNAME=store001-chat.example.com
export VERIFONE_HOSTNAME=store001-verifone.example.com
export TUNNEL_TOKEN='<cloudflare-tunnel-token>'
export INSTALL_CLOUDFLARE_SERVICE=true
bash scripts/install-oneclick.sh
```

## Linux aarch64

Use this on ARM64 edge devices:

```bash
export DASHBOARD_HOSTNAME=store001-dashboard.example.com
export VERIFONE_HOSTNAME=store001-verifone.example.com
bash scripts/install-oneclick-aarch64.sh
```

## Android

Android pilot installs are supported through Termux:

```bash
export DASHBOARD_HOSTNAME=store001-dashboard.example.com
export VERIFONE_HOSTNAME=store001-verifone.example.com
bash scripts/install-oneclick-android-termux.sh
```

## URLs After Install

- Marketing and lead capture: `/landing`
- Support chooser portal: `/portal`
- Store operator chat: `/chat`
- Dashboard: `/`
- Verifone ConfigClient: `/ConfigClient.html` on the Verifone Cloudflare hostname

## Cloudflare Access Rules

Apply Access policies before pilot use:

- Portal, dashboard, diagnostics, and Verifone hostnames: support/admin users only.
- Chat hostname: store operator users and support users.
- Require MFA for support/admin users.
- Keep the Verifone hostname proxied only through the tunnel. Do not expose the Commander LAN IP directly.

## Pilot Flow

1. Support runs the one-click installer with the store hostnames and tunnel token.
2. Installer installs dependencies, pulls GitHub, builds the app, starts the local API, and configures cloudflared.
3. Support opens the portal URL through Cloudflare Access.
4. Support completes workspace, store, Shre activation, Commander connection, and CStoreSKU settings.
5. Store operator receives the chat URL.
6. Operator asks questions through chat; support keeps using the portal/dashboard for diagnostics.
