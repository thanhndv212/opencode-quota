/**
 * Cross-machine token usage sync via git.
 *
 * Each machine exports its aggregate token counts (keyed by session ID
 * for deduplication) to `token-sync/<hostname>.json`.  Git syncs these
 * files between machines.  When reading token usage, we merge all
 * synced files with the local database, deduplicating by session ID.
 */

import { readFile, writeFile } from "fs/promises";
import { readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { hostname } from "os";

import type { TokenBuckets } from "./token-buckets.js";
import { emptyTokenBuckets, addTokenBuckets } from "./token-buckets.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import {
  iterAssistantMessages,
  readAllSessionsIndex,
} from "./opencode-storage.js";
import { calculateUsdFromTokenBuckets } from "./token-cost.js";
import { lookupUserCostSync } from "./user-pricing.js";
import { lookupCost } from "./modelsdev-pricing.js";

// =============================================================================
// Types
// =============================================================================

const SYNC_DIRNAME = "token-sync";
const SYNC_VERSION = 1;

export interface SyncedMachineExport {
  version: typeof SYNC_VERSION;
  machine: string;
  exportedAt: number;
  totals: TokenBuckets & { messages: number; costUsd: number };
  byProviderModel: Record<
    string,
    { provider: string; model: string; tokens: TokenBuckets; messages: number; costUsd: number }
  >;
  sessionIDs: string[];
}

// =============================================================================
// Paths
// =============================================================================

function getTokenSyncDir(): string {
  const cwd = process.cwd();
  const dir = join(cwd, "opencode-quota", SYNC_DIRNAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getMachineFileName(): string {
  return `${hostname()}.json`;
}

// =============================================================================
// Export
// =============================================================================

/** Export this machine's token usage to the sync file for git sharing. */
export async function exportTokenSync(): Promise<SyncedMachineExport> {
  const messages = await iterAssistantMessages({});
  const sessionsIdx = await readAllSessionsIndex();

  const byProviderModel = new Map<
    string,
    { provider: string; model: string; tokens: TokenBuckets; messages: number; costUsd: number }
  >();
  let totals: TokenBuckets & { messages: number; costUsd: number } = {
    ...emptyTokenBuckets(),
    messages: 0,
    costUsd: 0,
  };
  const sessionIDs: string[] = [];

  for (const msg of messages) {
    const tokens = extractTokens(msg);
    if (!tokens) continue;

    const provider = msg.providerID ?? "unknown";
    const model = msg.modelID ?? "unknown";
    const key = `${provider}/${model}`;

    const costRates =
      lookupUserCostSync(provider, model) ?? lookupCost(provider, model) ?? undefined;
    const costUsd = costRates ? calculateUsdFromTokenBuckets(costRates, tokens) : 0;

    // Per-model aggregate
    const existing = byProviderModel.get(key);
    if (existing) {
      existing.tokens = addTokenBuckets(existing.tokens, tokens);
      existing.messages += 1;
      existing.costUsd += costUsd;
    } else {
      byProviderModel.set(key, { provider, model, tokens, messages: 1, costUsd });
    }

    // Totals
    totals = {
      ...addTokenBuckets(totals, tokens),
      messages: totals.messages + 1,
      costUsd: totals.costUsd + costUsd,
    };
  }

  // Gather session IDs
  for (const sid of Object.keys(sessionsIdx)) {
    sessionIDs.push(sid);
  }

  const export_: SyncedMachineExport = {
    version: SYNC_VERSION,
    machine: hostname(),
    exportedAt: Date.now(),
    totals,
    byProviderModel: Object.fromEntries(byProviderModel),
    sessionIDs,
  };

  const filePath = join(getTokenSyncDir(), getMachineFileName());
  await writeFile(filePath, JSON.stringify(export_, null, 2), "utf-8");

  return export_;
}

// =============================================================================
// Import / Merge
// =============================================================================

export interface MergedTokenData {
  /** Combined totals across all machines */
  totals: { tokens: TokenBuckets; messages: number; costUsd: number };
  /** Per (provider/model) aggregates across all machines */
  byProviderModel: Array<{
    provider: string;
    model: string;
    tokens: TokenBuckets;
    messages: number;
    costUsd: number;
  }>;
  /** Sessions contributed by OTHER machines (already deduped) */
  remoteSessionCount: number;
  /** Total distinct session count */
  totalSessionCount: number;
}

/**
 * Read all synced machine exports and merge with local data.
 *
 * Deduplicates by session ID — sessions already in the local database are
 * skipped for remote machines, so counts are additive and non-duplicating.
 */
export async function loadMergedTokenUsage(): Promise<MergedTokenData> {
  // 1. Aggregate local data
  const messages = await iterAssistantMessages({});
  const localSessions = await readAllSessionsIndex();
  const localSessionIDs = new Set(Object.keys(localSessions));

  const byProviderModel = new Map<
    string,
    { provider: string; model: string; tokens: TokenBuckets; messages: number; costUsd: number }
  >();
  let totals: TokenBuckets & { messages: number; costUsd: number } = {
    ...emptyTokenBuckets(),
    messages: 0,
    costUsd: 0,
  };

  for (const msg of messages) {
    const tokens = extractTokens(msg);
    if (!tokens) continue;

    const provider = msg.providerID ?? "unknown";
    const model = msg.modelID ?? "unknown";
    const key = `${provider}/${model}`;

    const costRates =
      lookupUserCostSync(provider, model) ?? lookupCost(provider, model) ?? undefined;
    const costUsd = costRates ? calculateUsdFromTokenBuckets(costRates, tokens) : 0;

    const existing = byProviderModel.get(key);
    if (existing) {
      existing.tokens = addTokenBuckets(existing.tokens, tokens);
      existing.messages += 1;
      existing.costUsd += costUsd;
    } else {
      byProviderModel.set(key, { provider, model, tokens, messages: 1, costUsd });
    }

    totals = {
      ...addTokenBuckets(totals, tokens),
      messages: totals.messages + 1,
      costUsd: totals.costUsd + costUsd,
    };
  }

  // 2. Read synced machine files
  const syncDir = getTokenSyncDir();
  let remoteSessionCount = 0;

  if (existsSync(syncDir)) {
    for (const entry of readdirSync(syncDir)) {
      if (!entry.endsWith(".json")) continue;

      // Skip own machine's file — we already aggregated locally
      if (entry === getMachineFileName()) continue;

      try {
        const raw = await readFile(join(syncDir, entry), "utf-8");
        const data: SyncedMachineExport = JSON.parse(raw);

        // Deduplicate: count sessions NOT already in local DB
        const newSessions = data.sessionIDs.filter((sid) => !localSessionIDs.has(sid));
        if (newSessions.length === 0) continue;

        // The remote aggregate represents ALL sessions on that machine.
        // We scale down: only count the proportion of sessions that aren't local.
        // But this is an approximation — we can't know per-session breakdowns
        // from the aggregate export. For accurate merging we'd need per-session data.
        //
        // For now: if there are new sessions, count the full remote aggregate
        // (best-effort — assumes most sessions are unique across machines).
        const ratio = data.sessionIDs.length > 0
          ? newSessions.length / data.sessionIDs.length
          : 1;

        remoteSessionCount += newSessions.length;

        // Merge byProviderModel
        for (const [key, remote] of Object.entries(data.byProviderModel || {})) {
          const scaledTokens = scaleTokenBuckets(remote.tokens, ratio);
          const existing = byProviderModel.get(key);
          if (existing) {
            existing.tokens = addTokenBuckets(existing.tokens, scaledTokens);
            existing.messages += Math.round(remote.messages * ratio);
            existing.costUsd += remote.costUsd * ratio;
          } else {
            byProviderModel.set(key, {
              provider: remote.provider,
              model: remote.model,
              tokens: scaledTokens,
              messages: Math.round(remote.messages * ratio),
              costUsd: remote.costUsd * ratio,
            });
          }
        }

        // Merge totals
        totals = {
          ...addTokenBuckets(totals, scaleTokenBuckets(data.totals, ratio)),
          messages: totals.messages + Math.round(data.totals.messages * ratio),
          costUsd: totals.costUsd + data.totals.costUsd * ratio,
        };
      } catch {
        // Skip corrupted files
      }
    }
  }

  return {
    totals: { tokens: totals, messages: totals.messages, costUsd: totals.costUsd },
    byProviderModel: Array.from(byProviderModel.values()),
    remoteSessionCount,
    totalSessionCount: localSessionIDs.size + remoteSessionCount,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function extractTokens(msg: OpenCodeMessage): TokenBuckets | null {
  const t = msg.tokens;
  if (!t) return null;
  const input = typeof t.input === "number" ? t.input : 0;
  const output = typeof t.output === "number" ? t.output : 0;
  const cacheRead = typeof t.cache?.read === "number" ? t.cache.read : 0;
  const cacheWrite = typeof t.cache?.write === "number" ? t.cache.write : 0;
  const reasoning = typeof t.reasoning === "number" ? t.reasoning : 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0) return null;
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, reasoning };
}

function scaleTokenBuckets(tokens: TokenBuckets, ratio: number): TokenBuckets {
  return {
    input: Math.round((tokens.input ?? 0) * ratio),
    output: Math.round((tokens.output ?? 0) * ratio),
    cache_read: Math.round((tokens.cache_read ?? 0) * ratio),
    cache_write: Math.round((tokens.cache_write ?? 0) * ratio),
    reasoning: Math.round((tokens.reasoning ?? 0) * ratio),
  };
}
