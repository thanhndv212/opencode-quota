/**
 * Bridges the dashboard's usage_history table to the pricing/aggregation
 * pipeline that already backs the GUI's Token Usage tab (lib/quota-stats.ts'
 * aggregateUsage), instead of re-deriving per-model cost from scratch.
 *
 * aggregateUsage's underlying query is an indexed time-range scan, so
 * recomputing a single day's totals and replacing the stored row (via
 * DashboardApi.setUsageForDate) is cheap enough to run on every quota
 * check for "today", with a one-time multi-day backfill at dashboard
 * startup for the rest of the history.
 */

import { aggregateUsage, type AggregateRow } from "../lib/quota-stats.js";
import type { DashboardApi } from "./api.js";

type AggregateUsageFn = typeof aggregateUsage;

function localDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfLocalDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function writeDayUsage(
  dashboardApi: Pick<DashboardApi, "setUsageForDate">,
  date: string,
  byModel: AggregateRow[],
): void {
  for (const row of byModel) {
    dashboardApi.setUsageForDate(row.key.provider, date, row.key.model, {
      tokensInput: row.tokens.input,
      tokensOutput: row.tokens.output,
      tokensCache: row.tokens.cache_read + row.tokens.cache_write,
      costUsd: row.costUsd,
      requestCount: row.messageCount,
    });
  }
}

/**
 * Recomputes and replaces today's usage_history rows for every priced
 * model. Safe to call repeatedly (e.g. on every quota check): each call
 * fully replaces today's row rather than adding to it.
 */
export async function syncTodayUsageHistory(
  dashboardApi: Pick<DashboardApi, "setUsageForDate">,
  aggregateUsageFn: AggregateUsageFn = aggregateUsage,
  now: number = Date.now(),
): Promise<void> {
  const sinceMs = startOfLocalDayMs(now);
  const aggregate = await aggregateUsageFn({ sinceMs, untilMs: now });
  writeDayUsage(dashboardApi, localDateString(now), aggregate.byModel);
}

/**
 * One-time backfill for the last `days` days. Intended for dashboard
 * server startup, not the hot toast/status-report path.
 */
export async function backfillUsageHistory(
  dashboardApi: Pick<DashboardApi, "setUsageForDate">,
  days: number,
  aggregateUsageFn: AggregateUsageFn = aggregateUsage,
  now: number = Date.now(),
): Promise<void> {
  for (let daysAgo = 0; daysAgo < days; daysAgo++) {
    const dayStart = startOfLocalDayMs(now - daysAgo * 24 * 60 * 60 * 1000);
    const dayEnd = daysAgo === 0 ? now : dayStart + 24 * 60 * 60 * 1000 - 1;
    const aggregate = await aggregateUsageFn({ sinceMs: dayStart, untilMs: dayEnd });
    writeDayUsage(dashboardApi, localDateString(dayStart), aggregate.byModel);
  }
}
