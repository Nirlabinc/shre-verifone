import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, hostname, platform, arch, totalmem, freemem, cpus } from "node:os";

const port = Number(process.env.PORT || 5480);
const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");
const uiRoot = resolve("apps/dashboard-ui");

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

async function ensureRuntime(): Promise<void> {
  await mkdir(join(runtimeRoot, "connections"), { recursive: true });
  await mkdir(join(runtimeRoot, "queue"), { recursive: true });
  await mkdir(join(runtimeRoot, "logs"), { recursive: true });
  await mkdir(join(runtimeRoot, "diagnostics"), { recursive: true });
}

async function readJson<T extends JsonValue>(relativePath: string, fallback: T): Promise<T> {
  const path = join(runtimeRoot, relativePath);
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(relativePath: string, value: JsonValue): Promise<void> {
  const path = join(runtimeRoot, relativePath);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function requestBody(req: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) as JsonValue : {};
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonValue): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function directorySize(path: string): Promise<{ files: number; bytes: number }> {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await directorySize(child);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await stat(child)).size;
    }
  }
  return { files, bytes };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path === "/api/health") {
    const storage = await directorySize(runtimeRoot);
    sendJson(res, 200, {
      ok: true,
      service: "dashboard-api",
      runtimeRoot,
      host: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model || "unknown",
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        freeMemoryBytes: freemem(),
      },
      storage,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (path === "/api/profile") {
    if (req.method === "GET") {
      sendJson(res, 200, await readJson("profile.json", {}));
      return;
    }
    if (req.method === "POST") {
      const body = await requestBody(req);
      await writeJson("profile.json", body);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (path === "/api/verifone/status") {
    sendJson(res, 200, {
      configured: existsSync(join(runtimeRoot, "connections", "verifone.json")),
      lastValidation: await readJson("connections/verifone-status.json", null),
    });
    return;
  }

  if (path === "/api/password/status") {
    sendJson(res, 200, await readJson("connections/password-status.json", {
      state: "unknown",
      daysRemaining: null,
      autoResetLastAttempt: null,
      userActionRequired: false,
    }));
    return;
  }

  if (path === "/api/queue") {
    sendJson(res, 200, await readJson("queue/status.json", {
      pending: 0,
      failed: 0,
      lastReplayAt: null,
      lastError: null,
    }));
    return;
  }

  if (path === "/api/diagnostics") {
    sendJson(res, 200, {
      runtimeRoot,
      health: "/api/health",
      profile: "/api/profile",
      verifone: "/api/verifone/status",
      password: "/api/password/status",
      queue: "/api/queue",
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveUi(res: ServerResponse): Promise<void> {
  const html = await readFile(join(uiRoot, "index.html"), "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function main(): Promise<void> {
  await ensureRuntime();
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    handleRequest(req, res, url.pathname).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.listen(port, () => {
    console.log(`dashboard-api listening on http://localhost:${port}`);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path.startsWith("/api/")) {
    await handleApi(req, res, path);
    return;
  }
  await serveUi(res);
}

await main();
