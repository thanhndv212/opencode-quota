/**
 * Cross-machine token usage sync via git.
 *
 * Each machine exports per-session token counts to `token-sync/<hostname>.json`.
 * Git syncs these files between machines.  On import, sessions already in the
 * local database are skipped — only truly new sessions are counted, so merging
 * is additive and non-duplicating.
 */

import { readFile, writeFile } from "fs/promises";
import { readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { hostname } from "os";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

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
const SYNC_VERSION = 2;

/** Per-session token record — compact for git-friendly diffs */
interface SyncedSessionRecord {
  /** provider/model key (e.g. "deepseek/deepseek-v4-pro") */
  k: string;
  /** raw tokens from the single message (we aggregate per-session before writing) */
  i: number;  // input
  o: number;  // output
  r?: number; // reasoning
  cr?: number; // cache_read
  cw?: number; // cache_write
}

export interface SyncedMachineExport {
  version: 2;
  machine: string;
  exportedAt: number;
  /** Map of sessionID → aggregated token record (one per session) */
  sessions: Record<string, SyncedSessionRecord>;
}

// =============================================================================
// Paths
// =============================================================================

function getTokenSyncDir(): string {
  if (process.env.OPENCODE_QUOTA_SYNC_DIR) {
    return process.env.OPENCODE_QUOTA_SYNC_DIR;
  }
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  const base = configDirs[0] ?? process.cwd();
  const dir = join(base, "opencode-quota", SYNC_DIRNAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getMachineFileName(): string {
  return `${hostname()}.json`;
}

// =============================================================================
// Export
// =============================================================================

/**
 * Export this machine's token usage — one record per session for precise
 * deduplication on the receiving end.
 */
export async function exportTokenSync(): Promise<SyncedMachineExport> {
  const messages = await iterAssistantMessages({});
  const sessionsIdx = await readAllSessionsIndex();

  // Aggregate tokens per session (sessions may have multiple assistant messages)
  const sessions = new Map<string, SyncedSessionRecord>();

  for (const msg of messages) {
    const tokens = extractTokens(msg);
    if (!tokens) continue;

    const sid = msg.sessionID;
    const existing = sessions.get(sid);
    if (existing) {
      existing.i += tokens.input ?? 0;
      existing.o += tokens.output ?? 0;
      existing.r = (existing.r ?? 0) + (tokens.reasoning ?? 0);
      existing.cr = (existing.cr ?? 0) + (tokens.cache_read ?? 0);
      existing.cw = (existing.cw ?? 0) + (tokens.cache_write ?? 0);
    } else {
      const provider = msg.providerID ?? "unknown";
      const model = msg.modelID ?? "unknown";
      sessions.set(sid, {
        k: `${provider}/${model}`,
        i: tokens.input ?? 0,
        o: tokens.output ?? 0,
        r: (tokens.reasoning ?? 0) || undefined,
        cr: (tokens.cache_read ?? 0) || undefined,
        cw: (tokens.cache_write ?? 0) || undefined,
      });
    }
  }

  const export_: SyncedMachineExport = {
    version: 2,
    machine: hostname(),
    exportedAt: Date.now(),
    sessions: Object.fromEntries(sessions),
  };

  const filePath = join(getTokenSyncDir(), getMachineFileName());
  await writeFile(filePath, JSON.stringify(export_, null, 2), "utf-8");

  return export_;
}

// =============================================================================
// Import / Merge
// =============================================================================

export interface MergedTokenData {
  totals: { tokens: TokenBuckets; messages: number; costUsd: number };
  byProviderModel: Array<{
    provider: string;
    model: string;
    tokens: TokenBuckets;
    messages: number;
    costUsd: number;
  }>;
  remoteSessionCount: number;
  totalSessionCount: number;
}

/**
 * Read all synced machine exports and merge with local data.
 *
 * Deduplication: a session is counted only once.  Sessions already present
 * in the local database are skipped in remote machines' exports.  Each
 * remote machine contributes only sessions that are truly new to this
 * machine — so multiple syncs never double-count.
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
    accumulateMessage(msg, byProviderModel, totals);
  }

  // 2. Read synced machine files
  const syncDir = getTokenSyncDir();
  let remoteSessionCount = 0;

  if (existsSync(syncDir)) {
    for (const entry of readdirSync(syncDir)) {
      if (!entry.endsWith(".json")) continue;
      if (entry === getMachineFileName()) continue;

      try {
        const raw = await readFile(join(syncDir, entry), "utf-8");
        const data: SyncedMachineExport = JSON.parse(raw);

        // v1 format: skip (superseded by v2 per-session records)
        if (data.version !== 2) continue;

        // Count only sessions NOT already in local DB — precise dedup
        for (const [sid, rec] of Object.entries(data.sessions)) {
          if (localSessionIDs.has(sid)) continue;

          remoteSessionCount++;
          const [provider, model] = rec.k.split("/", 2);

          const tokens = {
            input: rec.i,
            output: rec.o,
            reasoning: rec.r,
            cache_read: rec.cr,
            cache_write: rec.cw,
          } as TokenBuckets;

          const costRates =
            lookupUserCostSync(provider, model) ?? lookupCost(provider, model) ?? undefined;
          const costUsd = costRates ? calculateUsdFromTokenBuckets(costRates, tokens) : 0;

          const key = `${provider}/${model}`;
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

function accumulateMessage(
  msg: OpenCodeMessage,
  byProviderModel: Map<string, { provider: string; model: string; tokens: TokenBuckets; messages: number; costUsd: number }>,
  totals: TokenBuckets & { messages: number; costUsd: number },
): void {
  const tokens = extractTokens(msg);
  if (!tokens) return;

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

  // eslint-disable-next-line no-param-reassign
  totals.input = (totals.input ?? 0) + (tokens.input ?? 0);
  totals.output = (totals.output ?? 0) + (tokens.output ?? 0);
  totals.cache_read = (totals.cache_read ?? 0) + (tokens.cache_read ?? 0);
  totals.cache_write = (totals.cache_write ?? 0) + (tokens.cache_write ?? 0);
  totals.reasoning = (totals.reasoning ?? 0) + (tokens.reasoning ?? 0);
  totals.messages += 1;
  totals.costUsd += costUsd;
}
