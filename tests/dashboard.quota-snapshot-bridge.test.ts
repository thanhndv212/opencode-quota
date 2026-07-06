import { describe, expect, it, vi } from "vitest";

import {
  captureQuotaSnapshots,
  detectAndRecordWeeklyResets,
} from "../src/dashboard/quota-snapshot-bridge.js";
import type { QuotaProviderResult } from "../src/lib/entries.js";

function percentResult(entries: Array<{ percentRemaining: number; resetTimeIso?: string; label?: string; group?: string; name?: string }>): QuotaProviderResult {
  return {
    attempted: true,
    errors: [],
    entries: entries.map((e) => ({
      name: e.name ?? "Window",
      percentRemaining: e.percentRemaining,
      resetTimeIso: e.resetTimeIso,
      label: e.label,
      group: e.group,
    })),
  };
}

function valueResult(value: string): QuotaProviderResult {
  return {
    attempted: true,
    errors: [],
    entries: [{ kind: "value", name: "Credits", value }],
  };
}

function errorResult(message: string): QuotaProviderResult {
  return {
    attempted: true,
    errors: [{ label: "Claude", message }],
    entries: [],
  };
}

describe("captureQuotaSnapshots", () => {
  it("captures a snapshot per provider with percent-based entries", () => {
    const captureSnapshot = vi.fn();
    const providerResults = [
      {
        providerId: "anthropic",
        result: percentResult([
          { percentRemaining: 58, resetTimeIso: "2026-07-05T20:00:00Z", label: "5h", group: "Claude" },
          { percentRemaining: 80, resetTimeIso: "2026-07-07T00:00:00Z", label: "7d", group: "Claude" },
        ]),
      },
    ];

    captureQuotaSnapshots({ captureSnapshot }, providerResults);

    expect(captureSnapshot).toHaveBeenCalledTimes(1);
    const [providerId, quotaData] = captureSnapshot.mock.calls[0]!;
    expect(providerId).toBe("anthropic");
    expect(quotaData.percentRemaining).toBe(58); // worst-case (lowest) remaining across windows: min(58, 80)
    expect(quotaData.limits).toEqual([
      { kind: "5h", group: "Claude", percent: 42, severity: "normal", resets_at: "2026-07-05T20:00:00Z" },
      { kind: "7d", group: "Claude", percent: 20, severity: "normal", resets_at: "2026-07-07T00:00:00Z" },
    ]);
  });

  it("assigns warning/critical severity based on percent used", () => {
    const captureSnapshot = vi.fn();
    captureQuotaSnapshots(
      { captureSnapshot },
      [
        {
          providerId: "anthropic",
          result: percentResult([
            { percentRemaining: 25, label: "warn-window" }, // 75% used -> warning
            { percentRemaining: 5, label: "critical-window" }, // 95% used -> critical
          ]),
        },
      ],
    );

    const [, quotaData] = captureSnapshot.mock.calls[0]!;
    expect(quotaData.limits[0].severity).toBe("warning");
    expect(quotaData.limits[1].severity).toBe("critical");
  });

  it("skips providers with only value-kind entries", () => {
    const captureSnapshot = vi.fn();
    captureQuotaSnapshots(
      { captureSnapshot },
      [{ providerId: "opencode-go", result: valueResult("$12.45") }],
    );

    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  it("captures an error snapshot when a provider has no entries but a fetch error", () => {
    const captureSnapshot = vi.fn();
    captureQuotaSnapshots(
      { captureSnapshot },
      [
        {
          providerId: "anthropic",
          result: errorResult("Claude is not authenticated. Run `claude auth login` and try again."),
        },
      ],
    );

    expect(captureSnapshot).toHaveBeenCalledTimes(1);
    const [providerId, quotaData] = captureSnapshot.mock.calls[0]!;
    expect(providerId).toBe("anthropic");
    expect(quotaData).toEqual({
      percentRemaining: null,
      limits: [],
      error: "Claude is not authenticated. Run `claude auth login` and try again.",
    });
  });

  it("does not throw when captureSnapshot itself throws", () => {
    const captureSnapshot = vi.fn(() => {
      throw new Error("db locked");
    });

    expect(() =>
      captureQuotaSnapshots(
        { captureSnapshot },
        [{ providerId: "anthropic", result: percentResult([{ percentRemaining: 50 }]) }],
      ),
    ).not.toThrow();
  });

  it("captures independently for multiple providers", () => {
    const captureSnapshot = vi.fn();
    captureQuotaSnapshots(
      { captureSnapshot },
      [
        { providerId: "anthropic", result: percentResult([{ percentRemaining: 50 }]) },
        { providerId: "openai", result: percentResult([{ percentRemaining: 90 }]) },
        { providerId: "opencode-go", result: valueResult("$1.00") },
      ],
    );

    expect(captureSnapshot).toHaveBeenCalledTimes(2);
    expect(captureSnapshot.mock.calls.map((c) => c[0])).toEqual(["anthropic", "openai"]);
  });
});

describe("detectAndRecordWeeklyResets", () => {
  const PAST_RESET = "2020-01-01T00:00:00Z"; // always in the past
  const FUTURE_RESET = "2999-01-01T00:00:00Z"; // never passed

  function makeApi(previous: unknown) {
    return {
      getCurrentQuota: vi.fn(() => previous),
      recordWeeklyReset: vi.fn(),
    };
  }

  it("records a reset when the reset time passed and percent used dropped meaningfully", () => {
    const api = makeApi({
      limits: [{ kind: "7d", group: "Claude", percent: 90, severity: "critical", resets_at: PAST_RESET }],
    });

    detectAndRecordWeeklyResets(api, [
      { providerId: "anthropic", result: percentResult([{ percentRemaining: 95, resetTimeIso: PAST_RESET, label: "7d" }]) },
    ]);

    expect(api.recordWeeklyReset).toHaveBeenCalledTimes(1);
    expect(api.recordWeeklyReset).toHaveBeenCalledWith("anthropic", "7d", {
      used: 90,
      remaining: 95,
      limit: 100,
    });
  });

  it("does not record when the reset time has not passed yet", () => {
    const api = makeApi({
      limits: [{ kind: "7d", group: "Claude", percent: 90, severity: "critical", resets_at: FUTURE_RESET }],
    });

    detectAndRecordWeeklyResets(api, [
      { providerId: "anthropic", result: percentResult([{ percentRemaining: 95, resetTimeIso: FUTURE_RESET, label: "7d" }]) },
    ]);

    expect(api.recordWeeklyReset).not.toHaveBeenCalled();
  });

  it("does not record when percent used did not drop meaningfully (ordinary fluctuation)", () => {
    const api = makeApi({
      limits: [{ kind: "7d", group: "Claude", percent: 40, severity: "normal", resets_at: PAST_RESET }],
    });

    // Only a 5-point drop — below the 10-point threshold.
    detectAndRecordWeeklyResets(api, [
      { providerId: "anthropic", result: percentResult([{ percentRemaining: 65, resetTimeIso: PAST_RESET, label: "7d" }]) },
    ]);

    expect(api.recordWeeklyReset).not.toHaveBeenCalled();
  });

  it("does nothing when there is no previous snapshot", () => {
    const api = makeApi(null);

    detectAndRecordWeeklyResets(api, [
      { providerId: "anthropic", result: percentResult([{ percentRemaining: 50, resetTimeIso: PAST_RESET, label: "7d" }]) },
    ]);

    expect(api.recordWeeklyReset).not.toHaveBeenCalled();
  });

  it("does not throw when getCurrentQuota or recordWeeklyReset throw", () => {
    const throwingGet = {
      getCurrentQuota: vi.fn(() => {
        throw new Error("db locked");
      }),
      recordWeeklyReset: vi.fn(),
    };
    expect(() =>
      detectAndRecordWeeklyResets(throwingGet, [
        { providerId: "anthropic", result: percentResult([{ percentRemaining: 50, resetTimeIso: PAST_RESET }]) },
      ]),
    ).not.toThrow();

    const throwingRecord = makeApi({
      limits: [{ kind: "Window", group: "Window", percent: 90, severity: "critical", resets_at: PAST_RESET }],
    });
    throwingRecord.recordWeeklyReset.mockImplementation(() => {
      throw new Error("db locked");
    });
    expect(() =>
      detectAndRecordWeeklyResets(throwingRecord, [
        { providerId: "anthropic", result: percentResult([{ percentRemaining: 95, resetTimeIso: PAST_RESET }]) },
      ]),
    ).not.toThrow();
  });
});
