import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  readAuthFile: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
  };
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/home/test/.local/share/opencode"],
    configDirs: ["/home/test/.config/opencode"],
    cacheDirs: ["/home/test/.cache/opencode"],
    stateDirs: ["/home/test/.local/state/opencode"],
  }),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: authMocks.readAuthFile,
}));

const patPath = "/home/test/.config/opencode/copilot-quota-token.json";
const realEnv = process.env;

describe("queryCopilotQuota", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    process.env = { ...realEnv };
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReset();
    authMocks.readAuthFile.mockReset();
    authMocks.readAuthFile.mockResolvedValue({});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })) as any);
  });

  afterEach(() => {
    process.env = realEnv;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null when no PAT config and no OpenCode Copilot auth exist", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");

    await expect(queryCopilotQuota()).resolves.toBeNull();
  });

  it("uses /copilot_internal/user when OAuth is present and PAT is absent", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot-chat": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);

      if (target === "https://api.github.com/copilot_internal/user") {
        expect(init?.headers).toMatchObject({
          Authorization: "token oauth_access_token",
        });
        return new Response(
          JSON.stringify({
            quota: {
              used: 12,
              limit: 300,
              reset_at: "2026-02-01T00:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toMatchObject({
      success: true,
      mode: "user_quota",
      used: 12,
      total: 300,
      percentRemaining: 96,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/copilot_internal/user",
    );
  });

  it("allows negative percentRemaining when /copilot_internal/user reports usage above the quota total", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot-chat": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              quota: {
                used: 360,
                limit: 300,
                reset_at: "2026-02-01T00:00:00.000Z",
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toMatchObject({
      success: true,
      mode: "user_quota",
      used: 360,
      total: 300,
      percentRemaining: -20,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

  it("parses premium_interactions from /copilot_internal/user quota_snapshots", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);

      if (target === "https://api.github.com/copilot_internal/user") {
        expect(init?.headers).toMatchObject({
          Authorization: "token oauth_access_token",
        });
        return new Response(
          JSON.stringify({
            login: "slkiser",
            access_type_sku: "free_educational_quota",
            copilot_plan: "individual",
            quota_reset_date: "2026-04-01",
            quota_reset_date_utc: "2026-04-01T00:00:00.000Z",
            quota_snapshots: {
              premium_interactions: {
                entitlement: 300,
                quota_remaining: 230,
                remaining: 230,
                unlimited: false,
              },
            },
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toMatchObject({
      success: true,
      mode: "user_quota",
      used: 70,
      total: 300,
      percentRemaining: 76,
      resetTimeIso: "2026-04-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/copilot_internal/user",
    );
  });

  it("uses explicit percent_remaining from /copilot_internal/user when present", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              quota_reset_date_utc: "2026-05-01T00:00:00.000Z",
              quota_snapshots: {
                premium_interactions: {
                  entitlement: 1500,
                  remaining: 401,
                  percent_remaining: 26.7,
                  unlimited: false,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toMatchObject({
      success: true,
      mode: "user_quota",
      used: 1099,
      total: 1500,
      percentRemaining: 26,
      resetTimeIso: "2026-05-01T00:00:00.000Z",
    });
  });

  it("preserves explicit negative percent_remaining for over-quota responses", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              quota_reset_date_utc: "2026-05-01T00:00:00.000Z",
              quota_snapshots: {
                premium_interactions: {
                  entitlement: 300,
                  remaining: -60,
                  percent_remaining: -20,
                  unlimited: false,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toMatchObject({
      success: true,
      mode: "user_quota",
      used: 360,
      total: 300,
      percentRemaining: -20,
      resetTimeIso: "2026-05-01T00:00:00.000Z",
    });
  });

  it("treats explicit unlimited premium_interactions as unlimited", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token", refresh: "refresh" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              quota_reset_date_utc: "2026-04-01T00:00:00.000Z",
              quota_snapshots: {
                premium_interactions: {
                  entitlement: 1,
                  remaining: 1,
                  percent_remaining: 100,
                  unlimited: true,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const { formatCopilotQuota, queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toMatchObject({
      success: true,
      mode: "user_quota",
      used: 0,
      total: 1,
      percentRemaining: 100,
      unlimited: true,
      resetTimeIso: "2026-04-01T00:00:00.000Z",
    });
    expect(formatCopilotQuota(result)).toBe("Copilot Premium Interactions Unlimited");
  });

  it("returns a clear error when OAuth auth exists without an access token", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", refresh: "refresh_only" },
    });

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toMatchObject({
      success: false,
      error:
        "Copilot OAuth auth is configured but missing an access token required for GitHub /copilot_internal/user.",
    });
  });

  it("does not fall back to OpenCode auth when PAT config is invalid", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ token: "github_pat_123456789" }));
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      "Invalid copilot-quota-token.json",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an invalid PAT as blocking even when OAuth auth is configured", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ token: "github_pat_123456789" }));

    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    expect(diagnostics.pat.state).toBe("invalid");
    expect(diagnostics.oauth.configured).toBe(true);
    expect(diagnostics.effectiveSource).toBe("pat");
    expect(diagnostics.override).toBe("pat_overrides_oauth");
    expect(diagnostics.quotaApi).toBe("none");
    expect(diagnostics.billingMode).toBe("none");
    expect(diagnostics.billingScope).toBe("none");
    expect(diagnostics.billingApiAccessLikely).toBe(false);
    expect(diagnostics.remainingTotalsState).toBe("unavailable");
    expect(diagnostics.queryPeriod).toBeUndefined();
  });
});
