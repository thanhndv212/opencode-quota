/**
 * User-defined pricing overrides.
 *
 * Allows users to correct missing or incorrect pricing by defining custom
 * per-1M-token USD rates for any provider/model combination. These overrides
 * take precedence over the models.dev pricing snapshot.
 *
 * Data is persisted in the repo (opencode-quota/user-pricing.json) for git
 * sync when OPENCODE_QUOTA_SYNC_DIR is set, falling back to local config
 * (~/.config/opencode/opencode-quota/user-pricing.json). Cached in memory
 * for fast lookups during token-cost aggregation.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type { CostBuckets } from "./modelsdev-pricing.js";

// =============================================================================
// Types
// =============================================================================

export const USER_PRICING_VERSION = 1 as const;
export const USER_PRICING_DIRNAME = "opencode-quota";
export const USER_PRICING_FILENAME = "user-pricing.json";

export interface UserPricingOverride {
  /** Provider ID (e.g. "anthropic", "openai", "google") */
  provider: string;
  /** Model ID as it appears in OpenCode messages (e.g. "claude-sonnet-4-5") */
  model: string;
  /** Per-1M-token USD rates. Partial buckets allowed — unset fields fall through to models.dev. */
  rates: CostBuckets;
  /** Human-readable note (e.g. "Custom pricing for internal model") */
  label?: string;
  /** When this override was created (epoch ms) */
  createdAt: number;
  /** When this override was last updated (epoch ms) */
  updatedAt: number;
}

export interface UserPricingStore {
  version: typeof USER_PRICING_VERSION;
  /** Map keyed by "provider/model" for O(1) lookup */
  overrides: Record<string, UserPricingOverride>;
}

// =============================================================================
// In-memory cache
// =============================================================================

let cachedStore: UserPricingStore | null = null;
let storeLoadedAt = 0;
const STORE_CACHE_TTL_MS = 30_000; // 30 seconds before re-reading from disk

// =============================================================================
// Path resolution
// =============================================================================

function getUserPricingFilePath(): string {
  // 1. OPENCODE_QUOTA_SYNC_DIR env var (set by OpenCode plugin runtime or CLI)
  if (process.env.OPENCODE_QUOTA_SYNC_DIR) {
    const repoPath = join(process.env.OPENCODE_QUOTA_SYNC_DIR, "..", USER_PRICING_FILENAME);
    if (existsSync(repoPath)) return repoPath;
  }

  // 2. Bundled in packaged Electron app (AppImage / dmg)
  // Electron sets process.resourcesPath to the resources/ directory.
  // extraResources copies into resources/opencode-quota/user-pricing.json.
  const resourcesPath = (process as unknown as Record<string, unknown>).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath) {
    const bundledPath = join(resourcesPath, USER_PRICING_DIRNAME, USER_PRICING_FILENAME);
    if (existsSync(bundledPath)) return bundledPath;
    // Also try at resources root (electron-builder may flatten nested extraResources)
    const flatPath = join(resourcesPath, USER_PRICING_FILENAME);
    if (existsSync(flatPath)) return flatPath;
  }

  // 3. Local config (~/.config/opencode/opencode-quota/user-pricing.json)
  const { configDir } = getOpencodeRuntimeDirs();
  return join(configDir, USER_PRICING_DIRNAME, USER_PRICING_FILENAME);
}

// =============================================================================
// Store I/O
// =============================================================================

function emptyStore(): UserPricingStore {
  return { version: USER_PRICING_VERSION, overrides: {} };
}

function makeKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

async function loadStore(forceReload = false): Promise<UserPricingStore> {
  const now = Date.now();
  if (
    !forceReload &&
    cachedStore &&
    now - storeLoadedAt < STORE_CACHE_TTL_MS
  ) {
    return cachedStore;
  }

  const filePath = getUserPricingFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    // Minimal validation
    if (parsed && typeof parsed === "object" && parsed.overrides && typeof parsed.overrides === "object") {
      cachedStore = parsed as UserPricingStore;
    } else {
      cachedStore = emptyStore();
    }
  } catch {
    cachedStore = emptyStore();
  }
  storeLoadedAt = now;
  return cachedStore;
}

async function saveStore(store: UserPricingStore): Promise<void> {
  const filePath = getUserPricingFilePath();
  await writeJsonAtomic(filePath, store, { trailingNewline: true });
  cachedStore = store;
  storeLoadedAt = Date.now();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get all user pricing overrides.
 */
export async function getUserPricingOverrides(): Promise<UserPricingOverride[]> {
  const store = await loadStore();
  return Object.values(store.overrides);
}

/**
 * Get a single user pricing override by provider and model.
 * Returns null if no override exists.
 */
export async function getUserPricingOverride(
  provider: string,
  model: string,
): Promise<UserPricingOverride | null> {
  const store = await loadStore();
  return store.overrides[makeKey(provider, model)] ?? null;
}

/**
 * Look up user-defined cost buckets for a provider/model pair.
 * Returns null if no override exists.
 */
export async function lookupUserCost(
  provider: string,
  model: string,
): Promise<CostBuckets | null> {
  const override = await getUserPricingOverride(provider, model);
  return override?.rates ?? null;
}

/**
 * Synchronous variant for hot paths during token aggregation.
 * Uses the in-memory cache; returns null on cache miss.
 */
export function lookupUserCostSync(provider: string, model: string): CostBuckets | null {
  if (!cachedStore) return null;
  const override = cachedStore.overrides[makeKey(provider, model)];
  return override?.rates ?? null;
}

/**
 * Set (create or update) a user pricing override.
 */
export async function setUserPricingOverride(params: {
  provider: string;
  model: string;
  rates: CostBuckets;
  label?: string;
}): Promise<UserPricingOverride> {
  const store = await loadStore();
  const key = makeKey(params.provider, params.model);
  const now = Date.now();
  const existing = store.overrides[key];

  const override: UserPricingOverride = {
    provider: params.provider,
    model: params.model,
    rates: params.rates,
    label: params.label,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.overrides[key] = override;
  await saveStore(store);
  return override;
}

/**
 * Remove a user pricing override.
 * Returns true if an override was removed, false if none existed.
 */
export async function removeUserPricingOverride(
  provider: string,
  model: string,
): Promise<boolean> {
  const store = await loadStore();
  const key = makeKey(provider, model);
  if (!store.overrides[key]) return false;

  delete store.overrides[key];
  await saveStore(store);
  return true;
}

/**
 * Remove all user pricing overrides for a given provider.
 * Returns the number of overrides removed.
 */
export async function removeUserPricingOverridesForProvider(
  provider: string,
): Promise<number> {
  const store = await loadStore();
  let count = 0;
  for (const key of Object.keys(store.overrides)) {
    if (key.startsWith(`${provider}/`)) {
      delete store.overrides[key];
      count++;
    }
  }
  if (count > 0) {
    await saveStore(store);
  }
  return count;
}

/**
 * Merge user pricing overrides with models.dev pricing for a given provider/model.
 * User overrides take precedence for any field they define.
 *
 * @param provider - Provider ID
 * @param model - Model ID
 * @param baseCost - Cost buckets from models.dev (or null if unknown)
 * @returns Merged cost buckets, or null if neither source has data
 */
export async function mergeUserCost(
  provider: string,
  model: string,
  baseCost: CostBuckets | null,
): Promise<CostBuckets | null> {
  const userCost = await lookupUserCost(provider, model);
  if (!userCost && !baseCost) return null;
  if (!userCost) return baseCost;
  if (!baseCost) return userCost;

  // Merge: user-defined fields win, rest fall through to base
  return {
    input: userCost.input ?? baseCost.input,
    output: userCost.output ?? baseCost.output,
    cache_read: userCost.cache_read ?? baseCost.cache_read,
    cache_write: userCost.cache_write ?? baseCost.cache_write,
    reasoning: userCost.reasoning ?? baseCost.reasoning,
  };
}

/**
 * Synchronous merge variant for hot paths.
 */
export function mergeUserCostSync(
  provider: string,
  model: string,
  baseCost: CostBuckets | null,
): CostBuckets | null {
  const userCost = lookupUserCostSync(provider, model);
  if (!userCost && !baseCost) return null;
  if (!userCost) return baseCost;
  if (!baseCost) return userCost;

  return {
    input: userCost.input ?? baseCost.input,
    output: userCost.output ?? baseCost.output,
    cache_read: userCost.cache_read ?? baseCost.cache_read,
    cache_write: userCost.cache_write ?? baseCost.cache_write,
    reasoning: userCost.reasoning ?? baseCost.reasoning,
  };
}

/**
 * Invalidate the in-memory cache, forcing a reload from disk on next access.
 */
export function clearUserPricingCache(): void {
  cachedStore = null;
  storeLoadedAt = 0;
}

/**
 * Preload the store into memory. Useful during app startup.
 */
export async function preloadUserPricing(): Promise<void> {
  await loadStore(true);
}
