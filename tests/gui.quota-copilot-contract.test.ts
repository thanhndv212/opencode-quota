import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/lib/copilot.js", () => ({
  queryCopilotQuota: mocks.query,
  hasCopilotQuotaRuntimeAvailable: async () => true,
}));
vi.mock("../src/providers/registry.js", async () => {
  const { copilotProvider } = await import("../src/providers/copilot.js");
  return { getProviders: () => [copilotProvider] };
});
import { fetchAllQuota } from "../src/gui/ipc/quota.js";

describe("Electron Copilot quota contracts", () => {
  it("carries usage-only credit rows and budget permission warnings to IPC without extra probes", async () => {
    mocks.query.mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "fixture-org",
      period: { year: 2026, month: 10 },
      unit: "ai_credits",
      authority: "provider_reported",
      used: 100,
      includedUsed: 80,
      billedUsed: 20,
      billedAmountUsd: 0.2,
      warnings: ["Budget report permission denied"],
    });
    const out = await fetchAllQuota({ ...DEFAULT_CONFIG, enabledProviders: ["copilot"] }, true);
    expect(out.detectedProviderIds).toEqual(["copilot"]);
    expect(out.entries[0]).toMatchObject({
      kind: "value",
      name: "Copilot AI Credits",
      value: "Used 100 | Included 80 | Billed 20 ($0.20) | 2026-10 | org=fixture-org",
    });
    expect(out.entries[0]).not.toHaveProperty("percentRemaining");
    expect(out.errors).toEqual([{ label: "Copilot", message: "Budget report permission denied" }]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
