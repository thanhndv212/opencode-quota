import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, existsSync } from "fs";

import {
  getUserPricingOverrides,
  getUserPricingOverride,
  setUserPricingOverride,
  removeUserPricingOverride,
  removeUserPricingOverridesForProvider,
  lookupUserCost,
  lookupUserCostSync,
  mergeUserCost,
  mergeUserCostSync,
  clearUserPricingCache,
  preloadUserPricing,
} from "../src/lib/user-pricing.js";

// We need to redirect the config dir to a temp directory.
// The module uses getOpencodeRuntimeDirs() internally.
// For testing, we set env vars to point to a temp dir.
const testDir = join(tmpdir(), `opencode-quota-test-user-pricing-${Date.now()}`);

function setupTestDirs() {
  mkdirSync(join(testDir, "opencode-quota"), { recursive: true });
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = testDir;
  process.env.XDG_DATA_HOME = testDir;
  process.env.XDG_CACHE_HOME = testDir;
  process.env.XDG_STATE_HOME = testDir;
  process.env.HOME = testDir;
  setupTestDirs();
  clearUserPricingCache();
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("user-pricing", () => {
  describe("getUserPricingOverrides", () => {
    it("returns empty array when no overrides exist", async () => {
      const overrides = await getUserPricingOverrides();
      expect(overrides).toEqual([]);
    });
  });

  describe("setUserPricingOverride", () => {
    it("creates a new override", async () => {
      const result = await setUserPricingOverride({
        provider: "openai",
        model: "gpt-5",
        rates: { input: 3.0, output: 15.0 },
        label: "Test override",
      });

      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-5");
      expect(result.rates.input).toBe(3.0);
      expect(result.rates.output).toBe(15.0);
      expect(result.label).toBe("Test override");
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.updatedAt).toBeGreaterThan(0);
    });

    it("updates an existing override", async () => {
      const first = await setUserPricingOverride({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        rates: { input: 3.0 },
      });

      const second = await setUserPricingOverride({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        rates: { input: 2.5, output: 12.5 },
      });

      expect(second.provider).toBe("anthropic");
      expect(second.model).toBe("claude-sonnet-4-5");
      expect(second.rates.input).toBe(2.5);
      expect(second.rates.output).toBe(12.5);
      expect(second.createdAt).toBe(first.createdAt); // preserved
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });

    it("persists across cache reloads", async () => {
      await setUserPricingOverride({
        provider: "google",
        model: "gemini-3-pro",
        rates: { input: 1.25, output: 5.0 },
      });

      clearUserPricingCache();
      const overrides = await getUserPricingOverrides();
      expect(overrides).toHaveLength(1);
      expect(overrides[0]!.provider).toBe("google");
    });
  });

  describe("getUserPricingOverride", () => {
    it("returns null for nonexistent override", async () => {
      const result = await getUserPricingOverride("nonexistent", "model");
      expect(result).toBeNull();
    });

    it("returns the override for a specific provider/model", async () => {
      await setUserPricingOverride({
        provider: "deepseek",
        model: "deepseek-v3",
        rates: { input: 0.27, output: 1.10 },
      });

      const result = await getUserPricingOverride("deepseek", "deepseek-v3");
      expect(result).not.toBeNull();
      expect(result!.rates.input).toBe(0.27);
    });
  });

  describe("lookupUserCost", () => {
    it("returns null when no override exists", async () => {
      const cost = await lookupUserCost("unknown", "unknown-model");
      expect(cost).toBeNull();
    });

    it("returns rates when override exists", async () => {
      await setUserPricingOverride({
        provider: "openai",
        model: "gpt-4o",
        rates: { input: 2.5, output: 10.0, cache_read: 0.5 },
      });

      const cost = await lookupUserCost("openai", "gpt-4o");
      expect(cost).toEqual({ input: 2.5, output: 10.0, cache_read: 0.5 });
    });
  });

  describe("lookupUserCostSync", () => {
    it("returns null when cache is not loaded", () => {
      const cost = lookupUserCostSync("any", "any");
      expect(cost).toBeNull();
    });

    it("returns rates after preload", async () => {
      await setUserPricingOverride({
        provider: "test",
        model: "test-model",
        rates: { input: 1.0 },
      });

      await preloadUserPricing();
      const cost = lookupUserCostSync("test", "test-model");
      expect(cost).toEqual({ input: 1.0 });
    });
  });

  describe("removeUserPricingOverride", () => {
    it("returns false when override does not exist", async () => {
      const result = await removeUserPricingOverride("none", "none");
      expect(result).toBe(false);
    });

    it("removes an existing override", async () => {
      await setUserPricingOverride({
        provider: "test",
        model: "to-delete",
        rates: { input: 1.0 },
      });

      const result = await removeUserPricingOverride("test", "to-delete");
      expect(result).toBe(true);

      const after = await getUserPricingOverride("test", "to-delete");
      expect(after).toBeNull();
    });
  });

  describe("removeUserPricingOverridesForProvider", () => {
    it("removes all overrides for a provider", async () => {
      await setUserPricingOverride({
        provider: "provider-a",
        model: "model-1",
        rates: { input: 1.0 },
      });
      await setUserPricingOverride({
        provider: "provider-a",
        model: "model-2",
        rates: { input: 2.0 },
      });
      await setUserPricingOverride({
        provider: "provider-b",
        model: "model-3",
        rates: { input: 3.0 },
      });

      const count = await removeUserPricingOverridesForProvider("provider-a");
      expect(count).toBe(2);

      const remaining = await getUserPricingOverrides();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.provider).toBe("provider-b");
    });
  });

  describe("mergeUserCost", () => {
    it("returns base cost when no user override exists", async () => {
      const merged = await mergeUserCost("none", "none", { input: 3.0, output: 15.0 });
      expect(merged).toEqual({ input: 3.0, output: 15.0 });
    });

    it("returns user cost when no base cost exists", async () => {
      await setUserPricingOverride({
        provider: "custom",
        model: "custom-model",
        rates: { input: 5.0, output: 25.0 },
      });

      const merged = await mergeUserCost("custom", "custom-model", null);
      expect(merged).toEqual({ input: 5.0, output: 25.0 });
    });

    it("returns null when neither source has data", async () => {
      const merged = await mergeUserCost("none", "none", null);
      expect(merged).toBeNull();
    });

    it("user override fields win over base cost", async () => {
      await setUserPricingOverride({
        provider: "openai",
        model: "gpt-5-merged",
        rates: { input: 99.0 }, // only override input
      });

      const base = { input: 3.0, output: 15.0, cache_read: 1.5 };
      const merged = await mergeUserCost("openai", "gpt-5-merged", base);

      expect(merged).toEqual({
        input: 99.0, // from user
        output: 15.0, // from base
        cache_read: 1.5, // from base
      });
    });
  });

  describe("mergeUserCostSync", () => {
    it("works with cached data", async () => {
      await setUserPricingOverride({
        provider: "synctest",
        model: "sync-model",
        rates: { input: 7.0 },
      });

      await preloadUserPricing();
      const merged = mergeUserCostSync("synctest", "sync-model", { input: 3.0, output: 10.0 });
      expect(merged).toEqual({ input: 7.0, output: 10.0 });
    });
  });
});
