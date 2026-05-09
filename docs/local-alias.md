# Local Alias

The local dashboard can use these loopback URLs:

```text
http://cstoresku:5480
http://localhost:5480
http://127.0.0.1:5480
```

`cstoresku.local` is also supported, but it can conflict with mDNS/Bonjour/Avahi on some networks. Prefer `cstoresku` for same-PC use.

## Windows

Check:

```powershell
npm run alias:check
```

Install as administrator:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File scripts\configure-local-alias.ps1 -Install'
```

Remove as administrator:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -File scripts\configure-local-alias.ps1 -Remove'
```

## macOS/Linux

Check:

```bash
./scripts/configure-local-alias.sh check
```

Install:

```bash
sudo ./scripts/configure-local-alias.sh install
```

Remove:

```bash
sudo ./scripts/configure-local-alias.sh remove
```

## Verification

After the API is running:

```text
http://cstoresku:5480/api/health
http://cstoresku:5480
```

The alias is a hosts-file loopback alias. It does not expose the dashboard to the LAN or internet.

## Security Notes

- Default API bind is `127.0.0.1`.
- Docker publishes `127.0.0.1:5480:5480`.
- Do not change `HOST=0.0.0.0` outside Docker unless TLS, authentication, and connector signing are enforced.
- The runtime manifest should be loaded through the active dashboard URL so it emits the expected local base URL.
