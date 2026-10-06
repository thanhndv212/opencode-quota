/**
 * DeepSeek provider wrapper.
 *
 * Queries the DeepSeek /user/balance endpoint and displays the
 * account balance as a value entry.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  formatDeepSeekBalanceValue,
  hasDeepSeekApiKeyConfigured,
  queryDeepSeekBalance,
  queryDeepSeekBalanceWithAuth,
} from "../lib/deepseek.js";
import { resolveDeepSeekApiKey } from "../lib/deepseek-auth.js";
import { deriveResolvedAuthIdentity } from "../lib/resolved-auth-identity.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult } from "./result-helpers.js";

function buildDeepSeekEntries(
  result: Extract<NonNullable<Awaited<ReturnType<typeof queryDeepSeekBalance>>>, { success: true }>,
): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];

  for (const info of result.balanceInfos) {
    entries.push({
      kind: "value",
      name: "DeepSeek Balance",
      group: "DeepSeek",
      label: "Balance:",
      value: formatDeepSeekBalanceValue({
        currency: info.currency,
        totalBalance: info.totalBalance,
      }),
    });
  }

  // If the API returned no balance info, show the availability status
  if (entries.length === 0) {
    entries.push({
      kind: "value",
      name: "DeepSeek",
      group: "DeepSeek",
      label: "Status:",
      value: result.isAvailable ? "Available" : "Low balance",
    });
  }

  return entries;
}

export const deepseekProvider: QuotaProvider = {
  id: "deepseek",

  cachePolicy: {
    kind: "resolved-auth",
    async prepare(ctx) {
      const resolved = await resolveDeepSeekApiKey();
      if (!resolved) return null;
      const identity = await deriveResolvedAuthIdentity({
        providerId: "deepseek",
        principal: { kind: "credential", value: resolved.key },
      });
      if (!identity) return null;
      return {
        identity,
        fetch: async () =>
          mapNullableProviderResult(
            await queryDeepSeekBalanceWithAuth(resolved, {
              requestTimeoutMs: ctx.config.requestTimeoutMs,
            }),
            {
              errorLabel: "DeepSeek",
              onSuccess: (result) => attemptedResult(buildDeepSeekEntries(result)),
            },
          ),
      };
    },
  },

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Check if the deepseek provider exists in opencode config
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "deepseek",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasDeepSeekApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["deepseek"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryDeepSeekBalance({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "DeepSeek",
      onSuccess: (result) => attemptedResult(buildDeepSeekEntries(result)),
    });
  },
};
