import { createResolvedAuthCachePolicy } from "./account-cache.js";
import { queryKimiQuotaWithAuth } from "../lib/kimi.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryKimiQuota } from "../lib/kimi.js";
import { DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS, resolveKimiAuthCached } from "../lib/kimi-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

function formatUsageRight(window: { used: number; limit: number }): string {
  return `${window.used}/${window.limit}`;
}

export const kimiCodeProvider: QuotaProvider = {
  id: "kimi-for-coding",

  cachePolicy: createResolvedAuthCachePolicy("kimi-for-coding", async (ctx) => {
    const auth = await resolveKimiAuthCached({ maxAgeMs: 0 });
    if (auth.state !== "configured") return null;
    return { credential: auth.apiKey, fetch: () => fetchWithAuth(ctx, auth) };
  }),

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "kimi-for-coding",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    const auth = await resolveKimiAuthCached({
      maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS,
    });
    return auth.state === "configured" || auth.state === "invalid";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "kimi-for-coding";
  },

  fetch: fetchWithAuth,
};

async function fetchWithAuth(
  ctx: QuotaProviderContext,
  auth?: { apiKey: string },
): Promise<QuotaProviderResult> {
  if (!auth) {
    const selected = await resolveKimiAuthCached({ maxAgeMs: DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS });
    if (selected.state === "none") return notAttemptedResult();
    if (selected.state === "invalid") return attemptedErrorResult("Kimi Code", selected.error);
  }

  const result = auth
    ? await queryKimiQuotaWithAuth(auth, { requestTimeoutMs: ctx.config?.requestTimeoutMs })
    : await queryKimiQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

  if (!result) {
    return notAttemptedResult();
  }

  if (!result.success) {
    return attemptedErrorResult("Kimi Code", result.error);
  }

  const entries: QuotaToastEntry[] = result.windows.map((window) => ({
    name: `${result.label} ${window.label}`,
    group: result.label,
    label: `${window.label}:`,
    right: formatUsageRight(window),
    percentRemaining: window.percentRemaining,
    resetTimeIso: window.resetTimeIso,
  }));

  return attemptedResult(entries, [], {
    singleWindowDisplayName: result.label,
  });
}
