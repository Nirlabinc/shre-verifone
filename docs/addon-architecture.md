# Add-on Architecture: FCC And Loyalty

FCC and Loyalty are optional marketplace modules. They should not be installed as part of the default POS/BOS package.

## Module Layers

```text
Base package
└─ verifone-commander
   ├─ POS/BOS read capture
   ├─ Commander write queue
   ├─ local SQLite storage
   ├─ access mode controls
   ├─ diagnostics
   └─ Shre connector bridge

Marketplace add-ons
├─ verifone-fcc
│  ├─ FCC status/read capture
│  ├─ FCC queued actions if approved
│  └─ FCC-specific scopes and logs
└─ verifone-loyalty
   ├─ loyalty status/read capture
   ├─ loyalty queued actions if approved
   └─ loyalty-specific scopes and logs
```

## Packaging Decision

- POS/BOS is the core install.
- FCC is an add-on.
- Loyalty is an add-on.
- Add-ons are discoverable in the marketplace manifest.
- Add-ons are disabled by default.
- Add-ons require Shre marketplace activation for the tenant/workspace/store.

The local runtime can host all modules, but the installer should only enable the base module unless the marketplace returns add-on entitlements.

## Dashboard Layout

The base Verifone Commander dashboard remains the place where the operator sees marketplace install state and shared configuration for optional add-ons. FCC and Loyalty should each have a dedicated dashboard once activated:

- Base dashboard: install/enable status, tenant/workspace/store link, shared access mode, shared health, queue counts, and links to add-on dashboards.
- FCC dashboard: FCC health, errors, recovery recommendations, troubleshooting actions, FCC-specific logs, and FCC message tools.
- Loyalty dashboard: loyalty sync health, loyalty profiles/events, loyalty queue, troubleshooting, and loyalty-specific message tools.

This keeps add-on configuration discoverable without crowding the POS/BOS workflow. Add-on runtime state still persists locally in `runtime.sqlite`; dedicated dashboards should read from the same local API or their own add-on service API.

## Marketplace IDs

| Module | Connector ID | Default | Dependency |
| --- | --- | --- | --- |
| POS/BOS | `verifone-commander` | enabled | none |
| FCC | `verifone-fcc` | disabled | `verifone-commander` |
| Loyalty | `verifone-loyalty` | disabled | `verifone-commander` |

## Scope Model

Base scopes:

- `sales.read`
- `sales.summary.read`
- `sync.write`
- `diagnostics.read`
- `credentials.status.read`

FCC scopes:

- `fcc.status.read`
- `fcc.sync.write`

Loyalty scopes:

- `loyalty.status.read`
- `loyalty.sync.write`

Write scopes must also pass local Commander access mode:

- `read_only`: add-on writes blocked.
- `read_write`: add-on reads and writes allowed if marketplace scopes are active.
- `write_only`: add-on writes allowed, read/query workflows blocked.

## Runtime Flow

Read/capture flow:

```text
FCC/Loyalty source
-> add-on connector adapter
-> local normalizer
-> runtime.sqlite
-> dashboard/chat/query tools
-> optional approved Shre event/training sync
```

Write/update flow:

```text
ShreChat/message gateway/dashboard
-> signed local API
-> marketplace scope check
-> local access mode check
-> outbound_queue
-> Commander lease
-> add-on adapter
-> FCC/Loyalty/Commander endpoint
-> activity and sync logs
```

## Data Model Recommendation

Do not overload `sales_snapshots` for add-ons. Add dedicated tables when live adapters are implemented:

- `fcc_snapshots`
- `fcc_events`
- `loyalty_profiles`
- `loyalty_events`
- `addon_installations`

Until those are implemented, add-on status should live in encrypted `app_state` and add-on actions should queue through `outbound_queue` with target `verifone-fcc` or `verifone-loyalty`.

## Dashboard Recommendation

Add an `Add-ons` page after marketplace activation:

- Installed/available modules.
- FCC status.
- Loyalty status.
- Last sync time.
- Queue count by add-on.
- Required scopes.
- Access mode compatibility.

Do not show FCC/Loyalty setup screens until the marketplace says the module is active for the tenant/workspace/store.

## Open Implementation Work

- Add-on install state is stored in encrypted `app_state` under `addons/installations`.
- Local API exposes `GET /api/addons`, `POST /api/addons/activate`, `GET /api/addons/fcc/status`, and `GET /api/addons/loyalty/status`.
- Dashboard has an `Add-ons` page with install/status, adapter status, remote access config, and MCP tool contract.
- Add marketplace activation flow for module-level entitlements.
- Add E2E tests for add-on disabled/enabled states and write-scope blocking.
- Implement live FCC and Loyalty protocol adapters.
