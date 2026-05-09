# Credential Acquisition

This document explains where store users get each credential during installation and how Shre/MIB activation should work.

## Verifone / CStoreSKU Application Key

The application key is not created by this local dashboard. It comes from the POS/backoffice integration owner.

Expected sources, in order:

1. Store operator checks existing CStoreSKU/RapidRMS or Verifone integration settings.
2. Store IT/support checks the existing Commander integration configuration.
3. Verifone/Commander dealer or support provider issues or confirms the application key if the Commander API requires one.
4. Rapid Infosoft support can enter it during assisted onboarding if the store already has the key.

Current behavior:

- The field is optional in this Phase 2 scaffold.
- If the live Commander integration requires an application key, the installer should mark the field required for that integration mode.
- The value is encrypted locally and redacted in API responses, logs, and the dashboard.

User-facing guidance:

```text
If your Commander or CStoreSKU integration already uses an application key, enter it here.
If you do not have one, leave it blank and continue. Support will tell you if your Commander connection requires it.
```

Do not ask users to email or paste this key into support tickets.

## Shre/MIB Tenant, Store Registry, And Activation

Users should not manually create signing secrets. The production flow should use an activation token or QR/link flow that hides technical secrets.

Recommended production flow:

```text
Shre/MIB admin creates tenant
-> admin creates or imports store
-> admin enables Verifone Commander connector
-> Shre/MIB generates one-time activation token
-> user installs local app
-> user enters activation token in local dashboard
-> local app exchanges token with connector.aros.live
-> connector.aros.live returns tenant/store mapping and connector config
-> local app stores activation locally
-> cloud gateway can route signed messages to this install
```

## Who Provides Each Shre/MIB Value

| Value | Who Creates It | Who Enters It | How User Gets It | Notes |
| --- | --- | --- | --- | --- |
| Tenant ID | Shre/MIB admin or marketplace signup | app auto-fills after activation | activation token exchange | Should represent the company/customer account. |
| Store ID | Shre/MIB admin, imported from CStoreSKU/RapidRMS, or support | app auto-fills after activation | activation token exchange or store picker | Must match the physical store being installed. |
| Connector ID | application default | nobody | built in | `verifone-commander`. |
| Registry URL | application default or Shre environment config | nobody in normal production | built in | Default: `https://connector.aros.live`. |
| Connector signing secret | connector.aros.live | app/installer stores it | activation token exchange | Should not be shown to regular users. |
| Activation token | Shre/MIB marketplace or support | user enters once | email, admin portal, QR code, or support session | Short-lived, one-time use. |
| Allowed sources | Shre/MIB admin | app receives it | activation token exchange | Examples: ShreChat, WhatsApp, Claude, Codex. |
| Entitlement state | Shre billing/admin system | app checks automatically | validation API | active/suspended/deactivated/rejected/offline pending. |
| Billing endpoint | Shre/MIB config | app receives or uses env default | activation/config API | Used for usage reporting/backfill. |

## User Steps To Obtain Shre/MIB Activation Info

### Self-Service Marketplace

1. User signs in to Shre/MIB marketplace.
2. User selects the correct tenant/company.
3. User adds or selects the store.
4. User chooses `Verifone Commander Connector`.
5. Marketplace generates an activation token or QR code.
6. User opens the local dashboard and pastes/scans the activation token.
7. Dashboard activates the connector and shows tenant/store status.
8. User sends a test message from ShreChat or the selected gateway.

### Assisted Support Setup

1. Support verifies the customer account in Shre/MIB.
2. Support creates or confirms tenant and store records.
3. Support enables `verifone-commander` for the store.
4. Support generates a one-time activation token.
5. Support has the user paste it into the local dashboard, or support enters it during a remote session.
6. Support validates the local connector, test message, queue, and usage reporting.

### Existing RapidRMS API Customer

1. Shre/MIB already has the tenant and store from `rapidrms-api`.
2. Admin enables a second connector: `verifone-commander`.
3. Shre/MIB links both connectors by the same tenant ID and store ID.
4. Activation token is generated for only the local Verifone Commander install.
5. Queries can route to either connector based on intent.

## What The Local App Should Ask For

Normal user prompt:

- Activation token.

Advanced/support prompt:

- Tenant ID.
- Store ID.
- Registry URL.
- Connector shared signing secret.

The advanced prompt should be hidden behind support/admin mode because manual secret entry is error-prone and exposes sensitive values.

## Activation Token Exchange Contract

Future endpoint:

```http
POST https://connector.aros.live/api/connectors/verifone-commander/activate
```

Request:

```json
{
  "activationToken": "one-time-token",
  "localManifest": {
    "connectorId": "verifone-commander",
    "schemaVersion": "2026-05-09"
  },
  "host": {
    "hostname": "store-pc",
    "platform": "win32",
    "arch": "x64"
  }
}
```

Response:

```json
{
  "status": "activated",
  "tenantId": "tenant_rapid_001",
  "storeId": "store_001",
  "connectorId": "verifone-commander",
  "registryUrl": "https://connector.aros.live",
  "sharedSecret": "generated-secret",
  "allowedSources": ["shre-chat", "whatsapp", "claude", "codex"],
  "entitlementState": "active",
  "billingEndpoint": "https://connector.aros.live/api/usage"
}
```

The local app should store returned secrets in the secure local vault/runtime configuration and never display them after activation.

## Security Rules

- Activation tokens should be short-lived and one-time use.
- Signing secrets should be machine-generated, not user-created.
- Signing secrets should not appear in screenshots, logs, or support tickets.
- Reinstalling a store PC should revoke the previous local endpoint or create a new activation.
- Suspended/deactivated tenants should keep local data capture but block metered chat/cloud relay.
