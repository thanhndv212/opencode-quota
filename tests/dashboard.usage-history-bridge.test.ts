import { describe, expect, it, vi } from "vitest";

import {
  backfillUsageHistory,
  syncTodayUsageHistory,
} from "../src/dashboard/usage-history-bridge.js";
import type { AggregateResult, AggregateRow } from "../src/lib/quota-stats.js";
import { emptyTokenBuckets } from "../src/lib/token-buckets.js";

function modelRow(overrides: Partial<AggregateRow> = {}): AggregateRow {
  return {
    key: { provider: "anthropic", model: "claude-sonnet-4-6" },
    tokens: { ...emptyTokenBuckets(), input: 100, output: 50, cache_read: 10 },
    costUsd: 1.23,
    messageCount: 3,
    ...overrides,
  };
}

function aggregateWith(byModel: AggregateRow[]): AggregateResult {
  return {
    window: {},
    totals: {
      priced: emptyTokenBuckets(),
      unknown: emptyTokenBuckets(),
      unpriced: emptyTokenBuckets(),
      costUsd: byModel.reduce((sum, r) => sum + r.costUsd, 0),
      messageCount: byModel.reduce((sum, r) => sum + r.messageCount, 0),
      sessionCount: 0,
    },
    bySourceProvider: [],
    bySourceModel: [],
    byModel,
    bySession: [],
    unknown: [],
    unpriced: [],
  };
}

describe("syncTodayUsageHistory", () => {
  it("queries the current local day and replaces today's row per model", async () => {
    const setUsageForDate = vi.fn();
    const aggregateUsageFn = vi.fn(async () => aggregateWith([modelRow()]));
    const now = new Date(2026, 6, 5, 15, 30).getTime(); // 2026-07-05 15:30 local

    await syncTodayUsageHistory({ setUsageForDate }, aggregateUsageFn, now);

    expect(aggregateUsageFn).toHaveBeenCalledTimes(1);
    const call = aggregateUsageFn.mock.calls[0]![0];
    expect(call.untilMs).toBe(now);
    expect(new Date(call.sinceMs).getHours()).toBe(0);

    expect(setUsageForDate).toHaveBeenCalledWith("anthropic", "2026-07-05", "claude-sonnet-4-6", {
      tokensInput: 100,
      tokensOutput: 50,
      tokensCache: 10,
      costUsd: 1.23,
      requestCount: 3,
    });
  });

  it("writes one row per model in the aggregate", async () => {
    const setUsageForDate = vi.fn();
    const aggregateUsageFn = vi.fn(async () =>
      aggregateWith([
        modelRow({ key: { provider: "anthropic", model: "claude-sonnet-4-6" } }),
        modelRow({ key: { provider: "openai", model: "gpt-5" } }),
      ]),
    );

    await syncTodayUsageHistory({ setUsageForDate }, aggregateUsageFn, Date.now());

    expect(setUsageForDate).toHaveBeenCalledTimes(2);
  });
});

describe("backfillUsageHistory", () => {
  it("calls aggregateUsage once per day going back `days` days, bounded to local day edges", async () => {
    const setUsageForDate = vi.fn();
    const aggregateUsageFn = vi.fn(async () => aggregateWith([]));
    const now = new Date(2026, 6, 5, 10, 0).getTime(); // 2026-07-05 10:00 local

    await backfillUsageHistory({ setUsageForDate }, 3, aggregateUsageFn, now);

    expect(aggregateUsageFn).toHaveBeenCalledTimes(3);
    const windows = aggregateUsageFn.mock.calls.map((c) => c[0]);

    // Most recent (today) window ends at `now`, not end-of-day.
    expect(windows[0].untilMs).toBe(now);
    // Older days end at 23:59:59.999 local, not `now`.
    expect(windows[1].untilMs).toBeLessThan(now);
    expect(new Date(windows[1].untilMs).getHours()).toBe(23);

    // Each day's start is midnight local time, one day apart.
    expect(new Date(windows[0].sinceMs).getHours()).toBe(0);
    expect(windows[0].sinceMs - windows[1].sinceMs).toBe(24 * 60 * 60 * 1000);
    expect(windows[1].sinceMs - windows[2].sinceMs).toBe(24 * 60 * 60 * 1000);
  });

  it("writes rows keyed by each day's date, replacing rather than accumulating", async () => {
    const setUsageForDate = vi.fn();
    const aggregateUsageFn = vi
      .fn()
      .mockResolvedValueOnce(aggregateWith([modelRow({ costUsd: 1 })]))
      .mockResolvedValueOnce(aggregateWith([modelRow({ costUsd: 2 })]));
    const now = new Date(2026, 6, 5, 10, 0).getTime();

    await backfillUsageHistory({ setUsageForDate }, 2, aggregateUsageFn, now);

    expect(setUsageForDate).toHaveBeenNthCalledWith(
      1,
      "anthropic",
      "2026-07-05",
      "claude-sonnet-4-6",
      expect.objectContaining({ costUsd: 1 }),
    );
    expect(setUsageForDate).toHaveBeenNthCalledWith(
      2,
      "anthropic",
      "2026-07-04",
      "claude-sonnet-4-6",
      expect.objectContaining({ costUsd: 2 }),
    );
  });
});
