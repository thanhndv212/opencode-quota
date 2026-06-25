/**
 * IPC handlers for token usage aggregation.
 * Wraps the existing quota-stats aggregation pipeline.
 */

import { aggregateUsage, type AggregateResult } from "../../lib/quota-stats.js";
import { getWindowSinceMs, type BudgetTimeWindow } from "../../lib/budget-alerts.js";
import type { TokenBuckets } from "../../lib/token-buckets.js";
import { emptyTokenBuckets, addTokenBuckets } from "../../lib/token-buckets.js";
import { exportTokenSync, loadMergedTokenUsage, type SyncedMachineExport } from "../../lib/token-sync.js";

export interface TokensQueryParams {
  windowMs?: number;
  window?: BudgetTimeWindow;
  sinceMs?: number;
  untilMs?: number;
}

export interface TokensQueryResult {
  aggregate: AggregateResult;
  window: { sinceMs?: number; untilMs?: number; label: string };
}

function getWindowLabel(params: TokensQueryParams): string {
  if (params.windowMs) {
    const hours = params.windowMs / (60 * 60 * 1000);
    if (hours < 48) return `${hours.toFixed(0)} hours`;
    const days = hours / 24;
    if (days < 60) return `${days.toFixed(0)} days`;
    return `${(days / 30).toFixed(0)} months`;
  }
  if (params.window) {
    switch (params.window) {
      case "day": return "24 hours";
      case "week": return "7 days";
      case "month": return "30 days";
      case "all": return "All time";
    }
  }
  if (params.sinceMs && params.untilMs) {
    const days = (params.untilMs - params.sinceMs) / (24 * 60 * 60 * 1000);
    return `${days.toFixed(0)} days`;
  }
  return "All time";
}

/**
 * Query aggregated token usage for a time window.
 */
export async function queryTokenUsage(params: TokensQueryParams): Promise<TokensQueryResult> {
  // Resolve time window
  let sinceMs = params.sinceMs;
  const untilMs = params.untilMs;

  if (!sinceMs) {
    if (params.windowMs) {
      sinceMs = Date.now() - params.windowMs;
    } else if (params.window) {
      sinceMs = getWindowSinceMs(params.window);
    }
  }

  const aggregate = await aggregateUsage({ sinceMs, untilMs });

  return {
    aggregate,
    window: {
      sinceMs,
      untilMs,
      label: getWindowLabel(params),
    },
  };
}

/**
 * Get a summary of all projects/workspaces with token usage.
 * Scans all sessions to find distinct project/workspace roots.
 */
export async function getProjectsWithUsage(): Promise<
  Array<{ workspace: string; sessionCount: number; messageCount: number; costUsd: number }>
> {
  // Read all sessions to discover workspace roots
  const { readAllSessionsIndex } = await import("../../lib/opencode-storage.js");
  const sessionsIdx = await readAllSessionsIndex();

  // Group sessions by workspace root (derived from session title or path)
  const workspaceMap = new Map<string, {
    sessions: string[];
  }>();

  for (const [sessionId, info] of Object.entries(sessionsIdx)) {
    // Attempt to extract workspace from title or use "default"
    const workspace = extractWorkspace(info.title) ?? "default";
    const existing = workspaceMap.get(workspace);
    if (existing) {
      existing.sessions.push(sessionId);
    } else {
      workspaceMap.set(workspace, { sessions: [sessionId] });
    }
  }

  // Aggregate usage per workspace
  const result: Array<{
    workspace: string;
    sessionCount: number;
    messageCount: number;
    costUsd: number;
  }> = [];

  for (const [workspace, { sessions }] of workspaceMap) {
    try {
      const aggregate = await aggregateUsage({
        sessionIDs: sessions.slice(0, 100), // limit to avoid SQLite param limit
      });
      result.push({
        workspace,
        sessionCount: sessions.length,
        messageCount: aggregate.totals.messageCount,
        costUsd: aggregate.totals.costUsd,
      });
    } catch {
      result.push({
        workspace,
        sessionCount: sessions.length,
        messageCount: 0,
        costUsd: 0,
      });
    }
  }

  // Sort by cost descending
  result.sort((a, b) => b.costUsd - a.costUsd);
  return result;
}

function extractWorkspace(title?: string): string | null {
  if (!title) return null;
  // Common patterns: "project-name", "/path/to/project", "project (branch)"
  // Extract the first segment
  const trimmed = title.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    // Path-based title — use last segment
    const parts = trimmed.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] ?? null;
  }
  // Use first word
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord || null;
}

/**
 * Aggregate token usage grouped by provider.
 */
export function groupByProvider(aggregate: AggregateResult): Map<string, {
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
}> {
  const map = new Map<string, { tokens: TokenBuckets; costUsd: number; messageCount: number }>();

  for (const row of aggregate.bySourceProvider) {
    map.set(row.providerID, {
      tokens: row.tokens,
      costUsd: row.costUsd,
      messageCount: row.messageCount,
    });
  }

  return map;
}

/**
 * Aggregate token usage grouped by model.
 */
export function groupByModel(aggregate: AggregateResult): Map<string, {
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
  provider: string;
  model: string;
}> {
  const map = new Map<string, {
    tokens: TokenBuckets;
    costUsd: number;
    messageCount: number;
    provider: string;
    model: string;
  }>();

  for (const row of aggregate.byModel) {
    const key = `${row.key.provider}/${row.key.model}`;
    map.set(key, {
      tokens: row.tokens,
      costUsd: row.costUsd,
      messageCount: row.messageCount,
      provider: row.key.provider,
      model: row.key.model,
    });
  }

  return map;
}

/**
 * Export local token usage to the sync file for cross-machine sharing.
 */
export async function exportToSync(): Promise<SyncedMachineExport> {
  return exportTokenSync();
}

/**
 * Load merged token usage from local DB + all synced machine files.
 */
export async function loadMergedUsage() {
  return loadMergedTokenUsage();
}
