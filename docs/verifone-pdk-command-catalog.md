# Verifone PDK Command Catalog

The local connector now includes a PDK command catalog extracted from `Verifone PDK.zip`.

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
