/** Resolve once: the credential identifying the cache must also perform the fetch. */

import type {
  QuotaProviderCachePolicy,
  QuotaProviderContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import { deriveResolvedAuthIdentity } from "../lib/resolved-auth-identity.js";

export function createResolvedAuthCachePolicy(
  providerId: string,
  resolve: (ctx: QuotaProviderContext) => Promise<{
    credential: string;
    qualifiers?: readonly string[];
    fetch: () => Promise<QuotaProviderResult>;
  } | null>,
): QuotaProviderCachePolicy {
  return {
    kind: "resolved-auth",
    async prepare(ctx) {
      const selected = await resolve(ctx);
      if (!selected) return null;
      const identity = await deriveResolvedAuthIdentity({
        providerId,
        principal: { kind: "credential", value: selected.credential },
        qualifiers: selected.qualifiers,
      });
      return identity ? { identity, fetch: selected.fetch } : null;
    },
  };
}
