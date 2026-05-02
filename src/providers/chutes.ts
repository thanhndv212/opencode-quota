/**
 * Chutes AI provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryChutesQuota, hasChutesApiKeyConfigured } from "../lib/chutes.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

export const chutesProvider: QuotaProvider = {
  id: "chutes",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "chutes",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasChutesApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["chutes"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryChutesQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Chutes", result.error);
    }

    return attemptedResult([
      {
        name: "Chutes",
        percentRemaining: result.percentRemaining,
        resetTimeIso: result.resetTimeIso,
      },
    ]);
  },
};
