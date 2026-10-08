import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, withConsumer } from "./lib/package-consumer.mjs";

const require = createRequire(import.meta.url);
const electron = require("electron");
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await withConsumer(process.argv[2], async (root) => {
  const profile = path.join(root, "profile");
  await mkdir(profile);
  const env = {
    ...process.env,
    HOME: profile,
    SHELL: "/bin/sh",
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
    XDG_STATE_HOME: path.join(profile, "state"),
    QUOTA_SMOKE_MAIN: path.join(root, "node_modules", pkg.name, "dist/gui/main.js"),
    QUOTA_SMOKE_VERSION: pkg.version,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENCODE_CONFIG_DIR;
  const settingsDir = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode-quota");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "quota-toast.json"),
    JSON.stringify({
      enabledProviders: ["cursor"],
      cursorPlan: "pro",
      requestTimeoutMs: 9000,
      pricingSnapshot: { source: "bundled", autoRefresh: 0 },
    }),
  );
  // A launch-directory sidecar must not override global settings.
  await mkdir(path.join(root, "opencode-quota"));
  await writeFile(
    path.join(root, "opencode-quota", "quota-toast.json"),
    JSON.stringify({ enabledProviders: ["openai"] }),
  );
  const args = [fileURLToPath(new URL("fixtures/gui-smoke.mjs", import.meta.url))];
  if (process.platform === "linux") args.push("--no-sandbox");
  await run(electron, args, { cwd: root, env, timeout: 45_000 });
});
