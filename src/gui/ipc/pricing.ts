/**
 * IPC handlers for pricing overrides and snapshot management.
 * Wraps user-pricing.ts and modelsdev-pricing.ts.
 */

import type { CostBuckets } from "../../lib/modelsdev-pricing.js";
import {
  getPricingSnapshotMeta,
  getPricingSnapshotHealth,
  lookupCost,
  listProviders,
  listModelsForProvider,
  maybeRefreshPricingSnapshot,
  getPricingSnapshotSource,
} from "../../lib/modelsdev-pricing.js";
import {
  getUserPricingOverrides,
  setUserPricingOverride,
  removeUserPricingOverride,
  lookupUserCost,
  type UserPricingOverride,
} from "../../lib/user-pricing.js";

export interface PricingSnapshotInfo {
  generatedAt: number;
  ageMs: number;
  stale: boolean;
  maxAgeMs: number;
  providerCount: number;
  modelCount: number;
}

export interface PricingListResult {
  overrides: UserPricingOverride[];
  snapshot: PricingSnapshotInfo | null;
}

/**
 * List all pricing overrides and snapshot info.
 */
export async function listPricing(): Promise<PricingListResult> {
  const overrides = await getUserPricingOverrides();

  const meta = getPricingSnapshotMeta();
  const health = getPricingSnapshotHealth();
  const source = getPricingSnapshotSource();

  let snapshotInfo: PricingSnapshotInfo | null = null;
  if (health && meta) {
    const providers = listProviders();
    let modelCount = 0;
    for (const providerId of providers) {
      modelCount += listModelsForProvider(providerId).length;
    }
    snapshotInfo = {
      generatedAt: meta.generatedAt,
      ageMs: health.ageMs,
      stale: health.stale,
      maxAgeMs: health.maxAgeMs,
      providerCount: providers.length,
      modelCount,
    };
  }

  return { overrides, snapshot: snapshotInfo };
}

/**
 * Save a pricing override.
 */
export async function savePricingOverride(params: {
  provider: string;
  model: string;
  rates: CostBuckets;
  label?: string;
}): Promise<UserPricingOverride> {
  return setUserPricingOverride({
    provider: params.provider,
    model: params.model,
    rates: params.rates,
    label: params.label,
  });
}

/**
 * Delete a pricing override.
 */
export async function deletePricingOverride(
  provider: string,
  model: string,
): Promise<boolean> {
  return removeUserPricingOverride(provider, model);
}

/**
 * Look up the effective cost for a provider/model (user override merged with snapshot).
 */
export async function lookupEffectiveCost(
  provider: string,
  model: string,
): Promise<CostBuckets | null> {
  // Check user override first
  const userCost = await lookupUserCost(provider, model);
  if (userCost) return userCost;

  // Fall through to models.dev snapshot
  return lookupCost(provider, model);
}

/**
 * Get all provider IDs available in the pricing snapshot.
 */
export function listSnapshotProviders(): string[] {
  return listProviders();
}

/**
 * Get all model IDs for a provider in the pricing snapshot.
 */
export function listSnapshotModels(provider: string): string[] {
  return listModelsForProvider(provider);
}

/**
 * Trigger a pricing snapshot refresh from models.dev.
 */
export async function refreshPricingSnapshot(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    await maybeRefreshPricingSnapshot({ force: true });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
