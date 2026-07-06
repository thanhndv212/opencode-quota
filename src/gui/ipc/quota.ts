/**
 * IPC handlers for quota data fetching.
 * Wraps the existing provider registry and quota-state pipeline.
 */

import type { QuotaProviderContext, QuotaToastEntry, QuotaToastError } from "../../lib/entries.js";
import { fetchQuotaProviderResult } from "../../lib/quota-state.js";
import { getProviders } from "../../providers/registry.js";
import type { QuotaToastConfig } from "../../lib/types.js";
import { DEFAULT_CONFIG } from "../../lib/types.js";

export interface QuotaFetchResult {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  detectedProviderIds: string[];
}

function buildMinimalProviderContext(
  config: QuotaToastConfig,
  bypassCache: boolean,
): QuotaProviderContext {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: { model: undefined } }),
      },
    },
    config: {
      googleModels: config.googleModels,
      anthropicBinaryPath: config.anthropicBinaryPath,
      alibabaCodingPlanTier: config.alibabaCodingPlanTier,
      cursorPlan: config.cursorPlan,
      cursorIncludedApiUsd: config.cursorIncludedApiUsd,
      cursorBillingCycleStartDay: config.cursorBillingCycleStartDay,
      opencodeGoWindows: config.opencodeGoWindows,
      requestTimeoutMs: config.requestTimeoutMs,
      enabledProviders: config.enabledProviders,
      bypassCache,
    },
  };
}

/**
 * Fetch quota data from all available providers.
 * Returns normalized entries and errors suitable for direct UI rendering.
 */
export async function fetchAllQuota(
  config: QuotaToastConfig,
  bypassCache = false,
): Promise<QuotaFetchResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const providers = getProviders();
  const ctx = buildMinimalProviderContext(mergedConfig, bypassCache);

  const entries: QuotaToastEntry[] = [];
  const errors: QuotaToastError[] = [];
  const detectedProviderIds: string[] = [];

  // Determine which providers to query
  const enabledList =
    mergedConfig.enabledProviders === "auto"
      ? providers
      : providers.filter((p) => mergedConfig.enabledProviders.includes(p.id));

  // Check availability and fetch in parallel
  const results = await Promise.allSettled(
    enabledList.map(async (provider) => {
      const available = await provider.isAvailable(ctx);
      if (!available) return null;

      const result = await fetchQuotaProviderResult({
        provider,
        ctx,
        ttlMs: bypassCache ? 0 : mergedConfig.minIntervalMs,
        bypassCache,
      });

      return { providerId: provider.id, result };
    }),
  );

  for (const settled of results) {
    if (settled.status === "rejected") continue;
    const item = settled.value;
    if (!item) continue;

    detectedProviderIds.push(item.providerId);

    if (item.result.entries.length > 0) {
      entries.push(...item.result.entries);
    }
    if (item.result.errors.length > 0) {
      errors.push(...item.result.errors);
    }
  }

  return { entries, errors, detectedProviderIds };
}
