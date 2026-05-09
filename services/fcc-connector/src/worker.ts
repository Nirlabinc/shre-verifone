import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { hostname, platform, arch, totalmem, freemem } from "node:os";
import { randomUUID } from "node:crypto";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const port = Number(process.env.FCC_PORT || 5483);
const host = process.env.FCC_HOST || "127.0.0.1";
const appVersion = process.env.APP_VERSION || process.env.npm_package_version || "0.1.0";
const buildChannel = process.env.BUILD_CHANNEL || process.env.SHRE_ENV || "local";
const buildSha = process.env.BUILD_SHA || "dev";
const fccEndpoint = process.env.FCC_ENDPOINT || "";
const fccMode = process.env.FCC_MODE || "diagnostic_only";

function sendJson(res: ServerResponse, statusCode: number, body: JsonValue): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function requestBody(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as JsonValue;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
}

function health(): JsonObject {
  const configured = Boolean(fccEndpoint);
  const checks: JsonObject[] = [
    {
      id: "fcc_endpoint_configured",
      ok: configured,
      severity: "critical",
      message: configured ? "FCC endpoint is configured." : "FCC endpoint is missing. Set FCC_ENDPOINT after FCC specs are confirmed.",
    },
    {
      id: "fcc_mode",
      ok: ["diagnostic_only", "read_only", "read_write"].includes(fccMode),
      severity: "critical",
      message: `FCC mode is ${fccMode}.`,
    },
    {
      id: "protocol_specs",
      ok: false,
      severity: "warning",
      message: "FCC protocol checks are placeholders until the full FCC specs are loaded.",
    },
  ];
  const blockers = checks.filter((check) => check.ok !== true && check.severity === "critical");
  return {
    ok: blockers.length === 0,
    service: "fcc-connector",
    version: appVersion,
    buildChannel,
    buildSha,
    mode: fccMode,
    endpointConfigured: configured,
    host: {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      totalMemoryBytes: totalmem(),
      freeMemoryBytes: freemem(),
    },
    checks,
    timestamp: new Date().toISOString(),
  };
}

function recommendations(): JsonObject {
  const status = health();
  const checks = Array.isArray(status.checks) ? status.checks.map((item) => item as JsonObject) : [];
  const suggestions = checks.filter((check) => check.ok !== true).map((check) => {
    if (check.id === "fcc_endpoint_configured") {
      return {
        id: "configure_fcc_endpoint",
        title: "Configure FCC endpoint",
        action: "Set FCC_ENDPOINT in the FCC container environment after confirming the FCC host/API from specs.",
      };
    }
    if (check.id === "protocol_specs") {
      return {
        id: "load_fcc_specs",
        title: "Load FCC specs",
        action: "Map FCC health, error, and recovery commands from the official specs into this adapter.",
      };
    }
    return {
      id: `review_${String(check.id || "check")}`,
      title: String(check.message || "Review FCC check"),
      action: "Review FCC connector configuration and logs.",
    };
  });
  return {
    service: "fcc-connector",
    suggestions,
    troubleshooting: [
      "Confirm the FCC module is enabled in marketplace for the tenant/workspace/store.",
      "Confirm the store PC can reach the FCC endpoint from the edge network.",
      "Confirm Commander access mode allows the requested FCC operation.",
      "Check queue target verifone-fcc for pending or failed work.",
      "Generate a diagnostics bundle from the main dashboard before support escalation.",
    ],
  };
}

function messageHelp(messageText: string): JsonObject {
  const text = messageText.toLowerCase();
  if (text.includes("health") || text.includes("status")) {
    return { intent: "fcc_health", response: health() };
  }
  if (text.includes("fix") || text.includes("troubleshoot") || text.includes("error")) {
    return { intent: "fcc_troubleshooting", response: recommendations() };
  }
  return {
    intent: "fcc_help",
    response: {
      message: "FCC connector can report health and troubleshooting recommendations now. Live FCC commands will be added after specs are mapped.",
      supportedMessages: ["fcc health", "fcc status", "fcc error help", "fcc troubleshooting"],
    },
  };
}

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  res.setHeader("x-request-id", requestId);
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname === "/health") {
      sendJson(res, 200, health());
      return;
    }
    if (url.pathname === "/version") {
      sendJson(res, 200, { service: "fcc-connector", version: appVersion, buildChannel, buildSha });
      return;
    }
    if (url.pathname === "/recommendations") {
      sendJson(res, 200, recommendations());
      return;
    }
    if (url.pathname === "/message" && req.method === "POST") {
      const body = await requestBody(req);
      const messageText = typeof body.messageText === "string" ? body.messageText : "";
      sendJson(res, 200, messageHelp(messageText));
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error), requestId });
  }
});

server.listen(port, host, () => {
  console.log(`fcc-connector listening on http://${host}:${port}`);
});
