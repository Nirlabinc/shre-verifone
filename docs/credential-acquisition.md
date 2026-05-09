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

Users should not manually create signing secrets. The production flow should use Shre Auth signup/login as the single setup authority. Shre Auth creates or finds the tenant, workspace, and store, activates the connector, and returns local connector credentials to the app.

Recommended production flow:

```text
user installs local app
-> user opens local dashboard
-> user signs up or signs in with Shre Auth
-> user enters company, workspace, and store name/code
-> Shre Auth creates or finds tenant
-> Shre Auth creates or finds workspace
-> Shre Auth creates or finds store registry record
-> Shre/MIB enables Verifone Commander connector
-> Shre/MIB returns tenant/workspace/store mapping and connector config
-> local app stores activation locally
-> cloud gateway can route signed messages to this install
```

## Who Provides Each Shre/MIB Value

| Value | Who Creates It | Who Enters It | How User Gets It | Notes |
| --- | --- | --- | --- | --- |
| Tenant ID | Shre Auth/MIB signup | app auto-fills after signup activation | Shre Auth signup/activation response | Should represent the company/customer account. |
| Workspace ID | Shre Auth/MIB signup | app auto-fills after signup activation | Shre Auth signup/activation response | Groups stores/connectors under the tenant. Required before public release. |
| Store ID | Shre Auth/MIB signup, imported from CStoreSKU/RapidRMS, or support | app auto-fills after signup activation | Shre Auth signup/activation response | Must match the physical store being installed. |
| Connector ID | application default | nobody | built in | `verifone-commander`. |
| Registry URL | application default or Shre environment config | nobody in normal production | built in | Default: `https://connector.aros.live`. |
| Connector signing secret | Shre Auth/MIB connector activation | app/installer stores it | signup/activation response | Should not be shown to regular users. |
| Activation token | Shre/MIB marketplace or support | user enters once only in fallback flow | email, admin portal, QR code, or support session | Short-lived, one-time use. Signup/login is preferred. |
| Allowed sources | Shre/MIB admin | app receives it | activation token exchange | Examples: ShreChat, WhatsApp, Claude, Codex. |
| Entitlement state | Shre billing/admin system | app checks automatically | validation API | active/suspended/deactivated/rejected/offline pending. |
| Billing endpoint | Shre/MIB config | app receives or uses env default | activation/config API | Used for usage reporting/backfill. |

## User Steps To Obtain Shre/MIB Activation Info

### Preferred Shre Auth Signup

1. User installs and opens the local dashboard.
2. User opens `Marketplace`.
3. User enters Shre Auth email/password, company, workspace, store name, and optional store code.
4. Dashboard calls `POST /api/shre/signup-activate`.
5. Local API calls Shre Auth when `SHRE_AUTH_SIGNUP_URL` is configured.
6. Shre Auth creates or finds tenant/workspace/store records and activates `verifone-commander`.
7. Local API stores tenant ID, workspace ID, store ID, and connector signing secret locally.
8. Dashboard shows connector as activated.
9. User sends a signed test message.

The local app should not store the Shre Auth password. It uses the password only for signup/login exchange and stores the returned connector credentials.

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

- Shre Auth email.
- Shre Auth password.
- Company name.
- Workspace name.
- Store name or store code.

Advanced/support prompt:

- Activation token.
- Tenant ID.
- Workspace ID.
- Store ID.
- Registry URL.
- Connector shared signing secret.

The advanced prompt should be hidden behind support/admin mode because manual secret entry is error-prone and exposes sensitive values.

## Shre Auth Signup Activation Contract

Local endpoint:

```http
POST /api/shre/signup-activate
```

Request:

```json
{
  "email": "owner@example.com",
  "password": "user-password",
  "company": "Rapid Infosoft LLC",
  "workspaceName": "Operations",
  "storeName": "Main Store",
  "storeCode": "store_001"
}
```

When `SHRE_AUTH_SIGNUP_URL` is configured, the local API forwards the signup/activation request to that Shre Auth endpoint with local manifest and host details. When it is not configured, the local API creates a simulated local activation for development and E2E testing.

Response:

```json
{
  "status": "activated",
  "tenantId": "tenant_rapid_001",
  "workspaceId": "workspace_ops_001",
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

Environment:

```text
SHRE_AUTH_SIGNUP_URL=
```

## Security Rules

- Activation tokens should be short-lived and one-time use.
- Signing secrets should be machine-generated, not user-created.
- Signing secrets should not appear in screenshots, logs, or support tickets.
- Reinstalling a store PC should revoke the previous local endpoint or create a new activation.
- Suspended/deactivated tenants should keep local data capture but block metered chat/cloud relay.
