import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runPowerShell(args, env = {}) {
  return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("runtime protection marker and reset override", { skip: process.platform !== "win32" }, async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "verifone-runtime-protect-"));
  try {
    const protect = runPowerShell(["-File", "scripts/protect-runtime.ps1", "-RuntimePath", runtimeRoot, "-MarkProtected", "-Assert"]);
    assert.equal(protect.status, 0, protect.stderr || protect.stdout);

    const markerPath = join(runtimeRoot, ".runtime-protected");
    assert.equal(existsSync(markerPath), true);
    assert.match(await readFile(markerPath, "utf8"), /protected=true/);

    const refused = runPowerShell(["-File", "scripts/protect-runtime.ps1", "-RuntimePath", runtimeRoot, "-AllowReset"]);
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stderr}${refused.stdout}`, /Runtime reset refused/);

    const allowed = runPowerShell(["-File", "scripts/protect-runtime.ps1", "-RuntimePath", runtimeRoot, "-AllowReset"], {
      ALLOW_VERIFONE_RUNTIME_RESET: "I_UNDERSTAND_DELETE_LOCAL_DATA",
    });
    assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
    assert.match(allowed.stdout, /Runtime reset override accepted/);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
