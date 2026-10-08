import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Real processes share only fixture disk state; no provider requests or user auth.
if (process.argv[2] === "--worker") {
  const account = process.argv[3];
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer fixture-${account}`);
    return Response.json({ quota: 100, used: account === "A" ? 10 : 70 });
  };
  const { chutesProvider: provider } = await import("../dist/providers/chutes.js");
  const { fetchQuotaProviderResult, readCachedProviderResult } =
    await import("../dist/lib/quota-state.js");
  const ctx = {
    client: {},
    config: {
      googleModels: [],
      alibabaCodingPlanTier: "lite",
      cursorPlan: "none",
      enabledProviders: ["chutes"],
    },
  };
  const params = { provider, ctx, ttlMs: 60000 };
  const result = await fetchQuotaProviderResult(params);
  const cached = await readCachedProviderResult(params);
  assert.equal(cached.hit, true);
  assert.deepEqual(cached.result, result);
  process.stdout.write(JSON.stringify({ requests, percent: result.entries[0].percentRemaining }));
} else {
  if (process.platform === "win32")
    throw new Error("This smoke requires protected POSIX identity storage");
  const root = await mkdtemp(join(tmpdir(), "quota-account-processes-"));
  const run = (account) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker", account], {
        env: {
          ...process.env,
          CHUTES_API_KEY: `fixture-${account}`,
          OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_CACHE_HOME: join(root, "cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) return reject(new Error(`Worker failed (${code}): ${stderr}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  try {
    const [a, b] = await Promise.all([run("A"), run("B")]);
    assert.deepEqual(a, { requests: 1, percent: 90 });
    assert.deepEqual(b, { requests: 1, percent: 30 });
    assert.deepEqual(await run("A"), { requests: 0, percent: 90 });
    assert.deepEqual(await run("B"), { requests: 0, percent: 30 });
    const cacheDir = join(root, "cache", "opencode", "quota-provider-state");
    const files = (await readdir(cacheDir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 2);
    for (const file of files) {
      const raw = await readFile(join(cacheDir, file), "utf8");
      assert.ok(!raw.includes("fixture-") && !raw.includes("rai1_"));
      assert.match(JSON.parse(raw).key, /^[a-f0-9]{64}$/u);
    }
    console.log(
      "Account-cache process smoke passed: concurrent accounts, shared identity key, restart reuse, opaque disk locators.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
