/**
 * Chutes AI provider wrapper.
 */

import { resolveChutesApiKey } from "../lib/chutes-config.js";
import { createResolvedAuthCachePolicy } from "./account-cache.js";
import { queryChutesQuotaWithAuth } from "../lib/chutes.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryChutesQuota, hasChutesApiKeyConfigured } from "../lib/chutes.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

export const chutesProvider: QuotaProvider = {
  id: "chutes",

  cachePolicy: createResolvedAuthCachePolicy("chutes", async (ctx) => {
    const auth = await resolveChutesApiKey();
    if (!auth) return null;
    return { credential: auth.key, fetch: () => fetchWithAuth(ctx, auth) };
  }),

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

  fetch: fetchWithAuth,
};

async function fetchWithAuth(
  ctx: QuotaProviderContext,
  auth?: { key: string },
): Promise<QuotaProviderResult> {
  const result = auth
    ? await queryChutesQuotaWithAuth(auth, { requestTimeoutMs: ctx.config?.requestTimeoutMs })
    : await queryChutesQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

  return mapNullableProviderResult(result, {
    errorLabel: "Chutes",
    onSuccess: (result) =>
      attemptedResult([
        {
          name: "Chutes",
          percentRemaining: result.percentRemaining,
          resetTimeIso: result.resetTimeIso,
        },
      ]),
  });
}
