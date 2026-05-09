#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key.startsWith("--")) {
    args.set(key.slice(2), value && !value.startsWith("--") ? value : "true");
    if (value && !value.startsWith("--")) i += 1;
  }
}

const baseUrl = args.get("base-url") || process.env.LOCAL_BASE_URL || "http://127.0.0.1:5480";
const secret = args.get("secret") || process.env.CONNECTOR_SHARED_SECRET || "";
const tenantId = args.get("tenant") || process.env.SHRE_TENANT_ID || "tenant_rapid_001";
const storeId = args.get("store") || process.env.SHRE_STORE_ID || "store_001";
const source = args.get("source") || "shre-cli";
const agentId = args.get("agent") || "shre-cli";
const messageText = args.get("message") || "What were sales today?";
const body = JSON.stringify({
  source,
  tenantId,
  storeId,
  userId: args.get("user") || "local_operator",
  messageId: args.get("message-id") || randomUUID(),
  messageText,
});

const headers = { "content-type": "application/json" };
if (secret) {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${tenantId}.${agentId}.${body}`)
    .digest("hex");
  headers["x-shre-timestamp"] = timestamp;
  headers["x-shre-nonce"] = nonce;
  headers["x-shre-tenant-id"] = tenantId;
  headers["x-shre-agent-id"] = agentId;
  headers["x-shre-signature"] = `sha256=${signature}`;
}

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/messages/inbound`, {
  method: "POST",
  headers,
  body,
});
const payload = await response.json().catch(() => ({}));
console.log(JSON.stringify({ status: response.status, ok: response.ok, payload }, null, 2));
process.exit(response.ok ? 0 : 1);
