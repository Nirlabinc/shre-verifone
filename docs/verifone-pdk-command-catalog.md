# Verifone PDK Command Catalog

The local connector now includes a PDK command catalog extracted from `Verifone PDK.zip`.

Operational rules for agents and workers are maintained in [Commander PDK Agent Rules](commander-pdk-agent-rules.md).

## Flow

PDK commands use the Commander CGILink endpoint:

```text
/cgi-bin/CGILink?cmd=<command>
```

The connector logs in with:

```text
cmd=validate&user=<username>&passwd=<password>
```

It extracts and caches the returned cookie, then sends catalog commands with:

```text
cmd=<command>&cookie=<cookie>
```

## API

```http
GET  /api/verifone/pdk/commands
POST /api/verifone/pdk/execute
POST /api/commander/writeback
```

Example:

```json
{
  "commandId": "vrubyrept.summary.filename",
  "params": {
    "period": "2",
    "filename": "example.xml"
  }
}
```

The executor:

- Uses the stored Commander URL, username, and password.
- Logs in and caches the PDK cookie.
- Acquires the Commander lease before execution.
- Blocks update/control commands unless access mode is `read_write` or `write_only`.
- Redacts credentials and cookies from diagnostics.
- Stores XML responses in `commander_reports`.

## CStoreSKU Write-Back

CStoreSKU write mode sends XML to this local backend. The backend does not mark the work complete just because the XML was accepted by the API. It uses this lifecycle:

1. Store the XML write as an encrypted `outbound_queue` item.
2. Acquire the single Commander lease so another local task cannot compete with the write.
3. Login to Commander with PDK `validate` and send the XML to the configured mutating command, for example `uPLUs`.
4. Run verification when supplied:
   - match expected text in the write response, or
   - run a read-back PDK command such as `vPLUs`, `vfuelprices`, or the matching `v*cfg` command and confirm expected XML/text exists.
5. Mark the queue item as `completed`, `verification_failed`, or `failed` and write an activity/sync attempt record.

Example:

```json
{
  "commandId": "uPLUs",
  "entityType": "inventory",
  "entityId": "sku-001",
  "xml": "<?xml version=\"1.0\"?><NAXML-PLUMaintenance><PLU><ItemCode>sku-001</ItemCode></PLU></NAXML-PLUMaintenance>",
  "verification": {
    "commandId": "vPLUs",
    "expectedReadContains": "sku-001"
  }
}
```

Default transport is `POST` with `application/xml`. If a site-specific Commander command requires the XML as a query parameter, set `"transport": "query_param"` and pass `"xmlParamName"` in `params`.

If no verification block is supplied, the backend tries an approved default mapping first:

- `uPLUs` verifies with `vPLUs`.
- `ufuelprices` and `cfuelprices` verify with `vfuelprices`.
- common `u*cfg` updates verify with the matching `v*cfg` command.

If no explicit or default verification rule exists, the write is not marked complete. It remains visible as a verification failure so support can add the correct read-back rule before go-live.

## Covered Command Groups

- Information: `vAppInfo`
- Credential: `validate`, `cenablelogin`
- Report availability lists: `vtlogpdlist`, `vcashierpdlist`, `vpayrollpdlist2`, `vcwpaypointpdlist`, `vreportpdlist`, `vviperpdList`
- Database reports through `vrubyrept`: summary, department, eCheck, tax, hourly, network, deal, PLU, category, cash acceptor, car wash, proprietary card/product, money order, network totals, car wash paypoint, eSafe reports
- Fuel reports through `vrubyrept`: POP discount, DCR status, hose, price level, tank, tank monitor/reconciliation, fuel totals, dispenser, blend product
- Transaction log reports: `vperiodrept`, `vperiodreptz`, `vperiodrept2`, `vtransset`, `vtranssetz`
- VIPER reports: batch totals, loyalty totals, payment totals, prepaid totals
- Mobile reports: category list, host list, report list, report
- Car wash pay point report
- Maintenance/configuration view/update commands from the PDK maintenance page
- Event notification commands
- Deprecated commands, marked as deprecated in the catalog

## Safety

Commands beginning with `u`, `c`, `changepasswd`, or `send` are treated as mutating. They are blocked in `read_only` mode.

Read XML normalization currently classifies and maps sales/movement, batch, fuel, tank, journal, PLU/item, department/category, tax, network/payment/VIPER, cashier/payroll, eSafe, car wash, and loyalty-style payloads into Conexxus/NAXML-aligned JSON while preserving raw XML as the source of record. The PLU/item path handles NAXML `ItemMaintenance` / `ITTDetail` and Sapphire `domain:PLUs`; the fuel path handles Sapphire `fuel:fuelPrices`.

Normalized records are projected into `commander_report_entities` and exposed at:

```http
GET /api/verifone/entities
```

Use `reportType`, `entityType`, and `limit` query parameters for local queries and dashboard/chat tooling.
