# MCP Server

The app now includes a local MCP stdio server that wraps the same local APIs used by the dashboard and connector.

```bash
npm run build
npm run start:mcp
```

Default target:

```text
http://127.0.0.1:5480
```

Override with:

```bash
LOCAL_API_URL=http://cstoresku:5480 npm run start:mcp
```

If the local API requires an admin token, pass:

```bash
LOCAL_ADMIN_TOKEN=... npm run start:mcp
```

## Tools

- `commander_sales_query`: local sales snapshot query.
- `commander_data_query`: normalized local PLU/item/fuel/tank/batch/payment/tax data query.
- `commander_entities`: list normalized Commander entity rows.
- `commander_health`: local diagnostics.
- `commander_pull_report`: pull Commander XML into the local database.
- `commander_writeback`: write XML to Commander with verification. Hidden unless `MCP_ENABLE_WRITES=true`.

## Security

MCP is read-only by default. Writeback requires all of the following:

- `MCP_ENABLE_WRITES=true`
- local Commander access mode allows writes
- local API authentication passes
- Commander lease can be acquired
- write-back verification succeeds

Raw Commander XML is not exposed through MCP tools. Chat/model clients receive normalized JSON answers and entity rows.

## Claude Desktop

After `npm run build`, add this server to Claude Desktop's MCP config:

```json
{
  "mcpServers": {
    "verifone-commander-shre-cstoresku": {
      "command": "node",
      "args": ["dist/services/mcp-server/src/server.js"],
      "cwd": "C:\\Users\\NiravPatel\\OneDrive - RapidRMS\\Desktop\\Verifone-Commander-Shre-Cstoresku",
      "env": {
        "LOCAL_API_URL": "http://127.0.0.1:5480",
        "LOCAL_ADMIN_TOKEN": "",
        "MCP_ENABLE_WRITES": "false"
      }
    }
  }
}
```

The running API also returns generated launch snippets:

```http
GET /api/mcp/client-config
```

## Codex Or Other MCP Clients

Use the same command, args, cwd, and env values returned by `/api/mcp/client-config`. Keep `MCP_ENABLE_WRITES=false` unless the operator explicitly enables write mode and Commander write-back verification.
