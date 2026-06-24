/**
 * IPC channel definitions shared between main process and preload.
 *
 * All renderer ↔ main communication goes through typed IPC channels.
 * The renderer has NO direct access to Node.js APIs or the filesystem.
 */

import type { QuotaToastEntry, QuotaToastError, SessionTokensData } from "../../lib/entries.js";
import type { TokenBuckets } from "../../lib/token-buckets.js";
import type { CostBuckets, PricingSnapshot } from "../../lib/modelsdev-pricing.js";
import type { UserPricingOverride } from "../../lib/user-pricing.js";
import type {
  BudgetAlertRule,
  BudgetAlertResult,
  BudgetAlertUsage,
  BudgetTimeWindow,
} from "../../lib/budget-alerts.js";
import type { ApiKeyInfo, ApiKeyStoreStatus } from "../../lib/apikey-store.js";
import type { ApiKeyShareEntry, ApiKeyImportResult } from "../../lib/apikey-sync.js";
import type { GuiConfig } from "../../lib/gui-config.js";
import type {
  AggregateResult,
  SourceProviderRow,
  SourceModelRow,
  AggregateRow,
  SessionRow,
  UnknownRow,
  UnpricedRow,
} from "../../lib/quota-stats.js";

// =============================================================================
// Channel name constants
// =============================================================================

export const IPC_CHANNELS = {
  // Quota
  QUOTA_FETCH: "quota:fetch",
  QUOTA_REFRESH: "quota:refresh",

  // Token usage
  TOKENS_QUERY: "tokens:query",
  TOKENS_PROJECTS: "tokens:projects",

  // Pricing
  PRICING_LIST: "pricing:list",
  PRICING_SAVE: "pricing:save",
  PRICING_DELETE: "pricing:delete",
  PRICING_SNAPSHOT: "pricing:snapshot",
  PRICING_REFRESH: "pricing:refresh",

  // Budget alerts
  ALERTS_LIST: "alerts:list",
  ALERTS_CREATE: "alerts:create",
  ALERTS_UPDATE: "alerts:update",
  ALERTS_DELETE: "alerts:delete",
  ALERTS_EVAL: "alerts:eval",

  // API keys
  APIKEYS_STATUS: "apikeys:status",
  APIKEYS_INIT: "apikeys:init",
  APIKEYS_UNLOCK: "apikeys:unlock",
  APIKEYS_LOCK: "apikeys:lock",
  APIKEYS_LIST: "apikeys:list",
  APIKEYS_GET: "apikeys:get",
  APIKEYS_GET_MASKED: "apikeys:getMasked",
  APIKEYS_SET: "apikeys:set",
  APIKEYS_DELETE: "apikeys:delete",
  APIKEYS_CHANGE_PASSPHRASE: "apikeys:changePassphrase",
  APIKEYS_EXPORT: "apikeys:export",
  APIKEYS_IMPORT: "apikeys:import",

  // GUI config
  CONFIG_GET: "config:get",
  CONFIG_UPDATE: "config:update",
  CONFIG_RESET: "config:reset",

  // App lifecycle
  APP_QUIT: "app:quit",
  APP_VERSION: "app:version",
} as const;

// =============================================================================
// IPC request/response types per channel
// =============================================================================

// --- Quota ---

export interface QuotaFetchRequest {
  bypassCache?: boolean;
}

export interface QuotaFetchResponse {
  entries: QuotaToastEntry[];
  errors: QuotaToastError[];
  sessionTokens?: SessionTokensData;
  detectedProviderIds: string[];
}

// --- Token usage ---

export interface TokensQueryRequest {
  windowMs?: number;        // rolling window in ms (takes precedence over window)
  window?: BudgetTimeWindow;
  groupBy: "model" | "provider" | "project";
  providerId?: string;      // filter to specific provider
  modelId?: string;         // filter to specific model
  projectPath?: string;     // filter to specific project
  sinceMs?: number;         // custom start time
  untilMs?: number;         // custom end time
}

export interface TokensQueryResponse {
  window: { sinceMs?: number; untilMs?: number };
  summary: {
    totalTokens: TokenBuckets;
    totalCostUsd: number;
    totalMessages: number;
    totalSessions: number;
  };
  byProvider: SourceProviderRow[];
  byModel: AggregateRow[];
  bySession: SessionRow[];
  unknown: UnknownRow[];
  unpriced: UnpricedRow[];
}

export interface TokensProjectsResponse {
  projects: Array<{ path: string; name: string; sessionCount: number }>;
}

// --- Pricing ---

export interface PricingListResponse {
  overrides: UserPricingOverride[];
  snapshot: PricingSnapshot | null;
  snapshotHealth: { generatedAt: number; ageMs: number; stale: boolean } | null;
}

export interface PricingSaveRequest {
  provider: string;
  model: string;
  rates: CostBuckets;
  label?: string;
}

export interface PricingSaveResponse {
  override: UserPricingOverride;
}

export interface PricingDeleteRequest {
  provider: string;
  model: string;
}

// --- Budget alerts ---

export interface AlertsEvalRequest {
  usageMap: Array<{
    key: string;
    usage: BudgetAlertUsage;
  }>;
}

export interface AlertsEvalResponse {
  results: BudgetAlertResult[];
  triggeredCount: number;
}

// --- API keys ---

export interface ApiKeysExportRequest {
  sharePassphrase: string;
  filePath: string;
}

export interface ApiKeysImportRequest {
  filePath: string;
  sharePassphrase: string;
}

// --- GUI config ---

export interface ConfigUpdateRequest {
  patch: Partial<GuiConfig>;
}
