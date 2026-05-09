# Security Hardening

## What Is Protected

- Runtime JSON values are encrypted before being stored in SQLite.
- Verifone password and application key are encrypted and redacted in API responses.
- Chat message text and connector responses are encrypted at rest.
- Queue payloads, diagnostics bundles, activity metadata, app state, and sales item details are encrypted at rest.
- Runtime folders and secret files use restrictive file permissions where the operating system supports them.
- Connector inbound requests use HMAC-SHA256 signing with timestamp, nonce, tenant ID, agent ID, and raw body.
- Signed connector nonces are stored and rejected on replay.
- Optional local admin token gates local sensitive APIs when `LOCAL_ADMIN_TOKEN` is set.
- The API binds to `127.0.0.1` by default.

## What Cannot Be Fully Prevented

A local application cannot be made impossible to reverse engineer. A determined attacker with administrator access to the machine can inspect binaries, memory, process arguments, local files, and network calls.

The practical goal is:

- Keep copied database files unreadable without the install secret.
- Prevent unsigned cloud/connector calls.
- Prevent casual local browser or cross-site requests.
- Minimize cleartext secrets in logs, diagnostics, and API responses.
- Keep the public protocol documented but secrets tenant-specific.

## Install Secret

If `VERIFONE_SHRE_SECRET` is not set, the app creates:

```text
<runtime>/.install-secret
```

This file is used to derive the local AES-256-GCM encryption key. Back it up with the runtime database if the same encrypted data must be moved to another PC.

For managed production installs, set a machine-specific `VERIFONE_SHRE_SECRET` through the installer or service manager.

## Local Admin Token

Set this for protected local APIs:

```text
LOCAL_ADMIN_TOKEN=<random long token>
```

When set, the browser UI requires the token in the header:

```text
x-local-admin-token
```

Connector inbound messages remain protected separately by `CONNECTOR_SHARED_SECRET` and HMAC signatures.

## Remaining Recommendations

- Use OS keychain or DPAPI/Keychain/libsecret for the install secret in production installers.
- Code-sign Windows/macOS installers.
- Add binary/package checksum verification.
- Avoid exposing `HOST=0.0.0.0` unless TLS and authentication are configured.
- Keep raw customer/payment-adjacent data out of diagnostics and remote learning.
