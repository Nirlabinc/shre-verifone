import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");

async function main(): Promise<void> {
  await mkdir(join(runtimeRoot, "queue"), { recursive: true });
  await writeFile(join(runtimeRoot, "queue", "status.json"), JSON.stringify({
    pending: 0,
    failed: 0,
    lastReplayAt: null,
    lastError: null,
    note: "Queue worker boundary is scaffolded. SQLite-backed replay is the next implementation step."
  }, null, 2), "utf8");
  console.log("queue-worker status initialized");
}

await main();
