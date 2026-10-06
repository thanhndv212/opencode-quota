import { mkdir, writeFile, rm } from "node:fs/promises";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const root = "/tmp/opencode-quota-deepseek-cache-tests";
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: [`${root}/data`],
    configDirs: [`${root}/config`],
    cacheDirs: [`${root}/cache`],
    stateDirs: [`${root}/state`],
  }),
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${root}/data`,
    configDir: `${root}/config`,
    cacheDir: `${root}/cache`,
    stateDir: `${root}/state`,
  }),
}));
const ctx = {
  config: {
    googleModels: [],
    alibabaCodingPlanTier: "lite",
    cursorPlan: "none",
    requestTimeoutMs: 1000,
  },
  client: {},
} as any;
describe("DeepSeek account cache adapter", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    await rm(root, { recursive: true, force: true });
    await mkdir(`${root}/config`, { recursive: true });
    await mkdir(`${root}/data`, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("fetches with the credential captured when the identity was prepared", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "fixture-key-A");
    const fetch = vi.fn(async () => Response.json({ is_available: true, balance_infos: [] }));
    vi.stubGlobal("fetch", fetch);
    const { deepseekProvider } = await import("../src/providers/deepseek.js");
    const policy = deepseekProvider.cachePolicy;
    expect(policy?.kind).toBe("resolved-auth");
    if (policy?.kind !== "resolved-auth") throw new Error("Missing identity adapter");
    const prepared = await policy.prepare(ctx);
    expect(prepared).not.toBeNull();
    vi.stubEnv("DEEPSEEK_API_KEY", "fixture-key-B");
    await prepared!.fetch();
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fixture-key-A" }),
      }),
    );
  });
  it("separates env, trusted global-config, and OpenCode-auth credentials", async () => {
    await writeFile(
      `${root}/config/opencode.json`,
      JSON.stringify({ provider: { deepseek: { options: { apiKey: "fixture-key-global" } } } }),
    );
    await writeFile(
      `${root}/data/auth.json`,
      JSON.stringify({ deepseek: { type: "api", key: "fixture-key-auth" } }),
    );
    vi.stubEnv("DEEPSEEK_API_KEY", "fixture-key-env");
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      const credential = (options.headers as Record<string, string>).Authorization;
      const total = credential.endsWith("env")
        ? "10.00"
        : credential.endsWith("global")
          ? "20.00"
          : "30.00";
      return Response.json({
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: total }],
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { deepseekProvider: provider } = await import("../src/providers/deepseek.js");
    const { fetchQuotaProviderResult, readCachedProviderResult } =
      await import("../src/lib/quota-state.js");
    const params = { provider, ctx, ttlMs: 60000 };
    const env = await fetchQuotaProviderResult(params);
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect(await readCachedProviderResult(params)).toEqual({ hit: false });
    const global = await fetchQuotaProviderResult(params);
    await rm(`${root}/config/opencode.json`);
    expect(await readCachedProviderResult(params)).toEqual({ hit: false });
    const auth = await fetchQuotaProviderResult(params);
    expect(env.entries).not.toEqual(global.entries);
    expect(global.entries).not.toEqual(auth.entries);
    await fetchQuotaProviderResult(params);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
