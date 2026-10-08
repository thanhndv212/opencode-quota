import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const dirs = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    configDir: join(dirs.root, "global"),
    dataDir: join(dirs.root, "data"),
    cacheDir: join(dirs.root, "cache"),
    stateDir: join(dirs.root, "state"),
  }),
  getOpencodeRuntimeDirCandidates: () => ({
    configDirs: [join(dirs.root, "global")],
    dataDirs: [join(dirs.root, "data")],
    cacheDirs: [join(dirs.root, "cache")],
    stateDirs: [join(dirs.root, "state")],
  }),
}));
import { getStandaloneProjectRoot, loadStandaloneQuotaConfig } from "../src/gui/quota-config.js";
import { loadConfig, createLoadConfigMeta } from "../src/lib/config.js";
import {
  getPricingSnapshotSelection,
  getPricingRefreshPolicy,
} from "../src/lib/modelsdev-pricing.js";
import { fetchAllQuota } from "../src/gui/ipc/quota.js";
import { resolveChutesApiKey } from "../src/lib/chutes-config.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), available: vi.fn() }));
vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => [
    { id: "cursor", isAvailable: mocks.available },
    {
      id: "openai",
      isAvailable: vi.fn(() => {
        throw new Error("disabled provider queried");
      }),
    },
  ],
}));
vi.mock("../src/lib/quota-state.js", () => ({ fetchQuotaProviderResult: mocks.fetch }));

async function writeSettings(root: string, settings: unknown) {
  await mkdir(join(root, "opencode-quota"), { recursive: true });
  await writeFile(join(root, "opencode-quota", "quota-toast.json"), JSON.stringify(settings));
}

describe("standalone quota configuration", () => {
  beforeEach(async () => {
    dirs.root = await mkdtemp(join(tmpdir(), "gui-config-"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", "");
    mocks.available.mockResolvedValue(true);
    mocks.fetch.mockResolvedValue({ entries: [], errors: [] });
  });
  afterEach(async () => {
    await rm(dirs.root, { recursive: true, force: true });
  });

  it("ignores launch cwd and keeps global settings classified as global", async () => {
    await writeSettings(join(dirs.root, "global"), { enabledProviders: ["cursor"] });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(dirs.root, "project"));
    try {
      await writeSettings(process.cwd(), { enabledProviders: ["openai"] });
      const loaded = await loadStandaloneQuotaConfig();
      expect(loaded.config.enabledProviders).toEqual(["cursor"]);
      expect(loaded.meta.workspaceConfigPaths).toEqual([]);
      expect(loaded.meta.globalConfigPaths).toHaveLength(1);
      expect(await getStandaloneProjectRoot([])).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
  });

  it("matches the shared loader for explicit roots and passes plan/timeout provenance to providers", async () => {
    const project = join(dirs.root, "project");
    await writeSettings(join(dirs.root, "global"), {
      enabledProviders: ["cursor"],
      requestTimeoutMs: 8000,
    });
    await writeSettings(project, {
      cursorPlan: "pro",
      cursorIncludedApiUsd: 42,
      requestTimeoutMs: 9000,
      pricingSnapshot: { source: "bundled", autoRefresh: 7 },
    });
    expect(await getStandaloneProjectRoot(["--project-dir", project])).toBe(project);
    const loaded = await loadStandaloneQuotaConfig(project);
    const meta = createLoadConfigMeta();
    expect(loaded.config).toEqual(await loadConfig(undefined, meta, { configRootDir: project }));
    expect(loaded.meta).toEqual(meta);
    expect(getPricingSnapshotSelection()).toBe("bundled");
    expect(getPricingRefreshPolicy().maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
    await fetchAllQuota(loaded.config, true, loaded.meta);
    expect(mocks.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          config: expect.objectContaining({
            cursorPlan: "pro",
            cursorIncludedApiUsd: 42,
            requestTimeoutMs: 9000,
            requestTimeoutMsConfigured: true,
            bypassCache: true,
          }),
        }),
        ttlMs: 0,
        bypassCache: true,
      }),
    );
  });

  it("reloads edited settings and reports malformed sidecars without reading legacy fallback", async () => {
    const global = join(dirs.root, "global");
    await writeSettings(global, { requestTimeoutMs: 8000 });
    expect((await loadStandaloneQuotaConfig()).config.requestTimeoutMs).toBe(8000);
    await writeSettings(global, { requestTimeoutMs: 9500 });
    expect((await loadStandaloneQuotaConfig()).config.requestTimeoutMs).toBe(9500);
    await writeFile(
      join(global, "opencode.json"),
      JSON.stringify({ experimental: { quotaToast: { requestTimeoutMs: 11000 } } }),
    );
    await writeFile(
      join(global, "opencode-quota", "quota-toast.json"),
      "malformed secret-like content",
    );
    const loaded = await loadStandaloneQuotaConfig();
    expect(loaded.meta.configIssues).toEqual([
      expect.objectContaining({ key: "$root", message: "expected readable JSON object" }),
    ]);
    expect(JSON.stringify(loaded)).not.toContain("secret-like");
    expect(loaded.config.requestTimeoutMs).not.toBe(11000);
  });

  it("supports an absolute environment root and rejects ambiguous or missing selections", async () => {
    const project = join(dirs.root, "project");
    await writeSettings(project, { enabledProviders: ["cursor"] });
    vi.stubEnv("OPENCODE_CONFIG_DIR", project);
    expect((await loadStandaloneQuotaConfig()).config.enabledProviders).toEqual(["cursor"]);
    vi.stubEnv("OPENCODE_CONFIG_DIR", "relative");
    await expect(loadStandaloneQuotaConfig()).rejects.toThrow("absolute directory");
    await expect(getStandaloneProjectRoot(["--project-dir"])).rejects.toThrow(
      "requires a directory",
    );
    await expect(
      getStandaloneProjectRoot(["--project-dir", join(project, "missing")]),
    ).rejects.toThrow();
  });

  it("does not consume provider secrets from the explicitly selected project", async () => {
    vi.stubEnv("CHUTES_API_KEY", "");
    const project = join(dirs.root, "project");
    await writeSettings(project, { enabledProviders: ["chutes"] });
    await writeFile(
      join(project, "opencode.json"),
      JSON.stringify({
        provider: { chutes: { options: { apiKey: "untrusted-project-key" } } },
      }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      const loaded = await loadStandaloneQuotaConfig(project);
      expect(loaded.config.enabledProviders).toEqual(["chutes"]);
      expect(await resolveChutesApiKey()).toBeNull();
      await mkdir(join(dirs.root, "global"), { recursive: true });
      await writeFile(
        join(dirs.root, "global", "opencode.json"),
        JSON.stringify({
          provider: { chutes: { options: { apiKey: "trusted-global-fixture" } } },
        }),
      );
      expect(await resolveChutesApiKey()).toMatchObject({ key: "trusted-global-fixture" });
    } finally {
      cwd.mockRestore();
    }
  });
});
