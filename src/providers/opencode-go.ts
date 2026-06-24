/**
 * OpenCode Go provider wrapper.
 *
 * Scrapes the OpenCode Go workspace dashboard and reports rolling (~5h),
 * weekly, and monthly usage as percentage-based quota entries.
 *
 * Supports multiple workspaces via:
 *   - JSON config: { "workspaces": [{ workspaceId, authCookie, label? }, ...] }
 *   - Env vars: OPENCODE_GO_WORKSPACE_ID, OPENCODE_GO_WORKSPACE_ID_2, ... OPENCODE_GO_WORKSPACE_ID_9
 *     with matching OPENCODE_GO_AUTH_COOKIE, OPENCODE_GO_AUTH_COOKIE_2, ...
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import type { OpenCodeGoResult, OpenCodeGoWindowKey } from "../lib/types.js";
import {
  DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
  resolveAllOpenCodeGoConfigs,
  resolveOpenCodeGoConfigCached,
  type OpenCodeGoConfig,
} from "../lib/opencode-go-config.js";
import { queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const OPENCODE_GO_WINDOW_LABELS: Record<
  OpenCodeGoWindowKey,
  { name: string; label: string; dashboardField: string }
> = {
  rolling: {
    name: `${OPENCODE_GO_PROVIDER_LABEL} 5h`,
    label: "5h:",
    dashboardField: "rollingUsage",
  },
  weekly: {
    name: `${OPENCODE_GO_PROVIDER_LABEL} Weekly`,
    label: "Weekly:",
    dashboardField: "weeklyUsage",
  },
  monthly: {
    name: `${OPENCODE_GO_PROVIDER_LABEL} Monthly`,
    label: "Monthly:",
    dashboardField: "monthlyUsage",
  },
};

function isDefaultOpenCodeGoWindowSelection(windows: OpenCodeGoWindowKey[]): boolean {
  const selected = new Set(windows);
  return (
    selected.size === OPENCODE_GO_WINDOW_ORDER.length &&
    OPENCODE_GO_WINDOW_ORDER.every((window) => selected.has(window))
  );
}

function formatMissingWindowList(windows: OpenCodeGoWindowKey[]): string {
  return windows.map((window) => `${window} (${OPENCODE_GO_WINDOW_LABELS[window].dashboardField})`).join(", ");
}

/**
 * Build quota entries for a single workspace's dashboard result.
 *
 * @param result - The scraped dashboard result
 * @param selectedWindows - Which windows to include
 * @param groupLabel - The group label for this workspace (e.g. "OpenCode Go (Acme)")
 * @param entryPrefix - Prefix for entry names (e.g. "OpenCode Go (Acme) "). If empty, uses bare names.
 */
function buildOpenCodeGoEntries(
  result: Extract<OpenCodeGoResult, { success: true }>,
  selectedWindows: OpenCodeGoWindowKey[],
  groupLabel: string,
  entryPrefix: string,
): QuotaToastEntry[] {
  const selected = new Set(selectedWindows);
  const entries: QuotaToastEntry[] = [];

  for (const window of OPENCODE_GO_WINDOW_ORDER) {
    if (!selected.has(window)) continue;

    const usage = result[window];
    if (!usage) continue;

    const labels = OPENCODE_GO_WINDOW_LABELS[window];
    entries.push({
      name: entryPrefix ? `${entryPrefix} ${labels.name.replace(OPENCODE_GO_PROVIDER_LABEL + " ", "")}` : labels.name,
      group: groupLabel,
      label: labels.label,
      percentRemaining: usage.percentRemaining,
      resetTimeIso: usage.resetTimeIso,
    });
  }

  return entries;
}

/**
 * Build display names for a workspace.
 */
function workspaceDisplayNames(cfg: OpenCodeGoConfig, isMulti: boolean): {
  groupLabel: string;
  entryPrefix: string;
} {
  if (!isMulti) {
    // Single workspace — use bare labels for backward compatibility
    return {
      groupLabel: OPENCODE_GO_PROVIDER_LABEL,
      entryPrefix: "",
    };
  }

  // Multi workspace — include the workspace label in group and entry names
  const label = cfg.label || cfg.workspaceId;
  return {
    groupLabel: `${OPENCODE_GO_PROVIDER_LABEL} (${label})`,
    entryPrefix: `${OPENCODE_GO_PROVIDER_LABEL} (${label})`,
  };
}

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveOpenCodeGoConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured" || config.state === "configured_multi";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode-go";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const config = await resolveOpenCodeGoConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
    });

    if (config.state === "none") {
      return notAttemptedResult();
    }

    if (config.state === "incomplete") {
      return attemptedErrorResult(
        OPENCODE_GO_PROVIDER_LABEL,
        `Missing ${config.missing} (source: ${config.source})`,
      );
    }

    if (config.state === "invalid") {
      return attemptedErrorResult(
        OPENCODE_GO_PROVIDER_LABEL,
        `Invalid config (${config.source}): ${config.error}`,
      );
    }

    // Resolve all workspaces (1 for single, N for multi)
    const allConfigs = await resolveAllOpenCodeGoConfigs();
    const isMulti = allConfigs.length > 1;
    const windows = ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
    const requestTimeoutMs = ctx.config?.requestTimeoutMsConfigured
      ? ctx.config.requestTimeoutMs
      : undefined;

    // Fetch all workspaces in parallel
    const fetchResults = await Promise.allSettled(
      allConfigs.map(async (cfg) => {
        const result = await queryOpenCodeGoQuota(cfg.workspaceId, cfg.authCookie, {
          requestTimeoutMs,
        });
        return { config: cfg, result };
      }),
    );

    // Collect entries and errors
    const allEntries: QuotaToastEntry[] = [];
    const allErrors: Array<{ label: string; message: string }> = [];
    let anySuccess = false;

    for (const settled of fetchResults) {
      if (settled.status === "rejected") {
        allErrors.push({
          label: OPENCODE_GO_PROVIDER_LABEL,
          message: `Unexpected error: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
        });
        continue;
      }

      const { config: cfg, result } = settled.value;

      if (!result) continue;

      if (!result.success) {
        allErrors.push({
          label: isMulti ? `${OPENCODE_GO_PROVIDER_LABEL} (${cfg.label || cfg.workspaceId})` : OPENCODE_GO_PROVIDER_LABEL,
          message: result.error,
        });
        continue;
      }

      anySuccess = true;
      const { groupLabel, entryPrefix } = workspaceDisplayNames(cfg, isMulti);
      const entries = buildOpenCodeGoEntries(result, windows, groupLabel, entryPrefix);

      // Check for missing windows in this workspace's result
      const missingSelectedWindows = windows.filter((window) => !result[window]);
      if (missingSelectedWindows.length > 0 && !isDefaultOpenCodeGoWindowSelection(windows)) {
        allErrors.push({
          label: groupLabel,
          message: `Selected OpenCode Go dashboard window(s) missing: ${formatMissingWindowList(missingSelectedWindows)}`,
        });
      }

      if (entries.length > 0) {
        allEntries.push(...entries);
      }
    }

    if (!anySuccess && allEntries.length === 0) {
      // If we have specific errors, return them; otherwise not attempted
      if (allErrors.length > 0) {
        return { attempted: true, entries: [], errors: allErrors };
      }
      return notAttemptedResult();
    }

    return attemptedResult(allEntries, allErrors.length > 0 ? allErrors : undefined);
  },
};
