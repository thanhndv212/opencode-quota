import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
const mocks = vi.hoisted(() => ({ providers: [] as any[], fetch: vi.fn() }));
vi.mock("../src/providers/registry.js", () => ({ getProviders: () => mocks.providers }));
vi.mock("../src/lib/quota-state.js", () => ({ fetchQuotaProviderResult: mocks.fetch }));
import { fetchAllQuota } from "../src/gui/ipc/quota.js";

describe("desktop provider failures", () => {
  it("shows rejected provider checks alongside successful quota without leaking exception text", async () => {
    mocks.providers = [
      {
        id: "copilot",
        isAvailable: vi.fn().mockRejectedValue(new Error("credential-like private detail")),
      },
      { id: "openai", isAvailable: vi.fn().mockResolvedValue(true) },
    ];
    mocks.fetch.mockResolvedValue({
      attempted: true,
      entries: [{ name: "OpenAI", percentRemaining: 42 }],
      errors: [],
    });
    const result = await fetchAllQuota({ ...DEFAULT_CONFIG, enabledProviders: "auto" });
    expect(result.entries).toEqual([{ name: "OpenAI", percentRemaining: 42 }]);
    expect(result.errors).toEqual([{ label: "Copilot", message: "Quota query failed" }]);
    expect(result.detectedProviderIds).toEqual(["openai"]);
  });
});
