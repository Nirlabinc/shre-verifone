# Cloudflare Remote Access

Use Cloudflare Zero Trust Tunnel for pilot remote access. Do not port-forward Verifone Commander or the local dashboard directly to the internet.

## Why The Verifone IP Can Vary

Different stores can use different Commander LAN IPs. Common examples:

```text
192.168.14.11
192.168.31.11
192.168.1.11
192.168.0.11
```

The installer script probes common candidates and also accepts an explicit `-VerifoneIp`.

## Recommended Hostnames

Use two separate hostnames and two separate Cloudflare Access policies:

```text
store001-dashboard.example.com -> http://localhost:5480
store001-verifone.example.com  -> http://<detected-verifone-ip>
```

Users open:

```text
https://store001-dashboard.example.com
https://store001-verifone.example.com/ConfigClient.html
```

## Cloudflare Prerequisites

Create these in Cloudflare Zero Trust before unattended install:

1. A tunnel for the store.
2. A tunnel token.
3. DNS routes for dashboard and Verifone hostnames.
4. Cloudflare Access policies requiring approved users and MFA.

The local installer can install and run `cloudflared`, but it should not create broad Access policy rules without a Cloudflare API token and account-specific approval.

## Install Script

Dry run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-cloudflare-remote-access.ps1 `
  -TunnelName "store001-verifone-commander" `
  -DashboardHostname "store001-dashboard.example.com" `
  -VerifoneHostname "store001-verifone.example.com" `
  -DryRun
```

Install with auto-detected Verifone IP:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-cloudflare-remote-access.ps1 `
  -TunnelName "store001-verifone-commander" `
  -TunnelToken "<cloudflare-tunnel-token>" `
  -DashboardHostname "store001-dashboard.example.com" `
  -VerifoneHostname "store001-verifone.example.com" `
  -LocalAdminToken "<optional-local-admin-token>" `
  -InstallService
```

Install with explicit Verifone IP:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-cloudflare-remote-access.ps1 `
  -TunnelName "store001-verifone-commander" `
  -TunnelToken "<cloudflare-tunnel-token>" `
  -DashboardHostname "store001-dashboard.example.com" `
  -VerifoneHostname "store001-verifone.example.com" `
  -VerifoneIp "192.168.31.11" `
  -InstallService
```

## Generated Ingress

The script writes:

```text
C:\ProgramData\cloudflared\<TunnelName>.yml
```

Shape:

```yaml
tunnel: store001-verifone-commander
ingress:
  - hostname: store001-dashboard.example.com
    service: http://localhost:5480
  - hostname: store001-verifone.example.com
    service: http://192.168.14.11
  - service: http_status:404
```

## Dashboard Registration

When the local API is reachable and authenticated, the script updates:

```http
POST /api/remote-access
```

Stored fields:

- dashboard public URL
- Verifone public URL
- Verifone LAN URL
- detected Verifone IP
- tunnel ID/name

## Security Rules

- Cloudflare Access is mandatory.
- Use stricter permissions for the Verifone hostname than the dashboard hostname.
- Enable MFA.
- Audit every remote support session.
- Keep the local dashboard bound to `127.0.0.1`.
- Do not expose Verifone Commander through DNS without Access policy.
