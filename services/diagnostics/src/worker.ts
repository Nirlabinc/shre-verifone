import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arch, cpus, freemem, homedir, hostname, platform, release, totalmem } from "node:os";

const runtimeRoot = process.env.VERIFONE_SHRE_HOME || join(homedir(), ".verifone-shre-cstoresku");

async function main(): Promise<void> {
  await mkdir(join(runtimeRoot, "diagnostics"), { recursive: true });
  const snapshot = {
    timestamp: new Date().toISOString(),
    host: hostname(),
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model || "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  };
  await writeFile(join(runtimeRoot, "diagnostics", "host-snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
  console.log("diagnostics snapshot written");
}

await main();
