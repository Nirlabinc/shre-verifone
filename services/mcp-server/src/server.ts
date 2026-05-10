import { createInterface } from "node:readline";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const localApiUrl = (process.env.LOCAL_API_URL || process.env.VERIFONE_LOCAL_API_URL || "http://127.0.0.1:5480").replace(/\/+$/, "");
const localAdminToken = process.env.LOCAL_ADMIN_TOKEN || "";
const writesEnabled = process.env.MCP_ENABLE_WRITES === "true";

const tools = [
  {
    name: "commander_sales_query",
    description: "Answer sales questions from the local Verifone Commander SQLite snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        businessDate: { type: "string", description: "Optional business date in YYYY-MM-DD format." },
      },
      required: ["query"],
    },
    method: "POST",
    path: "/api/sales/query",
    mutating: false,
  },
  {
    name: "commander_data_query",
    description: "Query normalized local Commander records such as PLU/item, fuel, tank, batch, payment, tax, department, or category data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        reportType: { type: "string", description: "Optional report type filter: plu, fuel, tank, batch, payment, tax, department, category." },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    method: "POST",
    path: "/api/commander/data-query",
    mutating: false,
  },
  {
    name: "commander_entities",
    description: "List normalized Commander entity rows from local SQLite.",
    inputSchema: {
      type: "object",
      properties: {
        reportType: { type: "string" },
        entityType: { type: "string" },
        limit: { type: "number" },
      },
    },
    method: "GET",
    path: "/api/verifone/entities",
    mutating: false,
  },
  {
    name: "commander_health",
    description: "Read local connector diagnostics and health.",
    inputSchema: { type: "object", properties: {} },
    method: "GET",
    path: "/api/diagnostics",
    mutating: false,
  },
  {
    name: "commander_pull_report",
    description: "Pull a Commander XML report into the local database. This reads Commander and changes local cache only.",
    inputSchema: {
      type: "object",
      properties: {
        reportType: { type: "string" },
        endpoint: { type: "string" },
        businessDate: { type: "string" },
      },
      required: ["reportType"],
    },
    method: "POST",
    path: "/api/verifone/pull-report",
    mutating: false,
  },
  {
    name: "commander_writeback",
    description: "Write XML back to Commander with read-back verification. Disabled unless MCP_ENABLE_WRITES=true.",
    inputSchema: {
      type: "object",
      properties: {
        commandId: { type: "string" },
        entityType: { type: "string" },
        entityId: { type: "string" },
        xml: { type: "string" },
        verification: { type: "object" },
      },
      required: ["commandId", "xml"],
    },
    method: "POST",
    path: "/api/commander/writeback",
    mutating: true,
  },
];

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id: JsonValue, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function callLocalApi(toolName: string, args: JsonObject): Promise<JsonObject> {
  const tool = tools.find((item) => item.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  if (tool.mutating && !writesEnabled) {
    throw new Error("MCP write tools are disabled. Set MCP_ENABLE_WRITES=true and keep Commander access mode read_write to allow this tool.");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (localAdminToken) headers["x-local-admin-token"] = localAdminToken;
  const query = new URLSearchParams();
  let url = `${localApiUrl}${tool.path}`;
  const init: RequestInit = { method: tool.method, headers };
  if (tool.method === "GET") {
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    if ([...query.keys()].length > 0) url = `${url}?${query.toString()}`;
  } else {
    init.body = JSON.stringify(args);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) as JsonObject : {};
  if (!response.ok) {
    throw new Error(String(body.message || body.error || `Local API returned HTTP ${response.status}`));
  }
  return body;
}

async function handle(message: JsonObject): Promise<void> {
  const id = message.id ?? null;
  const method = String(message.method || "");
  const params = typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? message.params as JsonObject : {};
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "verifone-commander-shre-cstoresku", version: "0.1.0" },
        },
      });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: tools
            .filter((tool) => !tool.mutating || writesEnabled)
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as JsonObject,
            })),
        },
      } as JsonObject);
      return;
    }
    if (method === "tools/call") {
      const name = String(params.name || "");
      const args = typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments) ? params.arguments as JsonObject : {};
      const result = await callLocalApi(name, args);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      });
      return;
    }
    send(errorResponse(id, -32601, `Method not found: ${method}`));
  } catch (error) {
    send(errorResponse(id, -32000, error instanceof Error ? error.message : String(error)));
  }
}

const lines = createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    void handle(JSON.parse(trimmed) as JsonObject);
  } catch (error) {
    send(errorResponse(null, -32700, error instanceof Error ? error.message : String(error)));
  }
});
