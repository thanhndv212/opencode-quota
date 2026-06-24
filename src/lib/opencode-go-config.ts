import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface OpenCodeGoConfig {
  workspaceId: string;
  authCookie: string;
  /** Optional human-readable label for this workspace (shown in quota displays) */
  label?: string;
}

export type ResolvedOpenCodeGoConfig =
  | { state: "none" }
  | { state: "configured"; config: OpenCodeGoConfig; source: string }
  | { state: "configured_multi"; configs: OpenCodeGoConfig[]; source: string }
  | { state: "incomplete"; source: string; missing: string }
  | { state: "invalid"; source: string; error: string };

export interface OpenCodeGoConfigDiagnostics {
  state: ResolvedOpenCodeGoConfig["state"];
  source: string | null;
  missing: string | null;
  error: string | null;
  checkedPaths: string[];
  workspaceCount: number;
}

type ReadConfigFileResult =
  | { state: "missing" }
  | { state: "loaded"; config: Record<string, unknown> }
  | { state: "invalid"; error: string };

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "opencode-go.json"));
}

function getConfigFileError(error: unknown): string {
  if (error instanceof SyntaxError) {
    return `Failed to parse JSON: ${error.message}`;
  }
  if (error instanceof Error && error.message) {
    return `Failed to read config file: ${error.message}`;
  }
  return `Failed to read config file: ${String(error)}`;
}

async function readConfigFile(path: string): Promise<ReadConfigFileResult> {
  try {
    const data = await readFile(path, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", error: "Config file must contain a JSON object" };
    }
    return { state: "loaded", config: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid", error: getConfigFileError(error) };
  }
}

function isValidWorkspaceConfig(obj: unknown): obj is OpenCodeGoConfig {
  if (!obj || typeof obj !== "object") return false;
  const c = obj as Record<string, unknown>;
  return typeof c.workspaceId === "string" && c.workspaceId.trim().length > 0
      && typeof c.authCookie === "string" && c.authCookie.trim().length > 0;
}

function normalizeWorkspaceConfig(raw: Record<string, unknown>): OpenCodeGoConfig | null {
  const workspaceId = typeof raw.workspaceId === "string" ? raw.workspaceId.trim() : "";
  const authCookie = typeof raw.authCookie === "string" ? raw.authCookie.trim() : "";
  if (!workspaceId || !authCookie) return null;
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
  return { workspaceId, authCookie, label };
}

// =============================================================================
// Env var resolution (supports suffixes for multiple workspaces)
// =============================================================================

/**
 * Resolve a single workspace from env vars (primary, no suffix).
 */
export function resolveOpenCodeGoConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenCodeGoConfig | null {
  const workspaceId = env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const authCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();
  const label = env.OPENCODE_GO_LABEL?.trim() || undefined;

  if (!workspaceId && !authCookie) return null;

  if (workspaceId && authCookie) {
    return {
      state: "configured",
      config: { workspaceId, authCookie, label },
      source: "env",
    };
  }

  return {
    state: "incomplete",
    source: "env",
    missing: workspaceId ? "OPENCODE_GO_AUTH_COOKIE" : "OPENCODE_GO_WORKSPACE_ID",
  };
}

/**
 * Resolve multiple workspaces from env vars with numeric suffixes.
 *
 * Supports:
 *   OPENCODE_GO_WORKSPACE_ID     (primary)
 *   OPENCODE_GO_WORKSPACE_ID_2   (additional)
 *   OPENCODE_GO_WORKSPACE_ID_3   (additional)
 *   ... up to _9
 *
 * Each workspace needs a matching AUTH_COOKIE with the same suffix.
 * Optional LABEL with matching suffix.
 */
function resolveMultiFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenCodeGoConfig | null {
  const configs: OpenCodeGoConfig[] = [];

  // Try primary first (no suffix)
  const primary = resolveOpenCodeGoConfigFromEnv(env);
  if (primary?.state === "configured") {
    configs.push(primary.config);
  }

  // Try suffixed entries (_2 through _9)
  for (let i = 2; i <= 9; i++) {
    const wsId = env[`OPENCODE_GO_WORKSPACE_ID_${i}`]?.trim();
    const cookie = env[`OPENCODE_GO_AUTH_COOKIE_${i}`]?.trim();
    const label = env[`OPENCODE_GO_LABEL_${i}`]?.trim() || undefined;

    if (wsId && cookie) {
      configs.push({ workspaceId: wsId, authCookie: cookie, label });
    }
  }

  if (configs.length === 0) return null;
  if (configs.length === 1) {
    return { state: "configured", config: configs[0]!, source: "env" };
  }
  return { state: "configured_multi", configs, source: "env" };
}

// =============================================================================
// JSON file resolution
// =============================================================================

function parseConfigFile(raw: Record<string, unknown>): ResolvedOpenCodeGoConfig | null {
  // ── Multi-workspace format: { "workspaces": [...] } ──
  if (Array.isArray(raw.workspaces)) {
    const configs: OpenCodeGoConfig[] = [];
    for (const item of raw.workspaces) {
      if (item && typeof item === "object") {
        const cfg = normalizeWorkspaceConfig(item as Record<string, unknown>);
        if (cfg) configs.push(cfg);
      }
    }
    if (configs.length === 0) return null;
    if (configs.length === 1) {
      return { state: "configured", config: configs[0]!, source: "file" };
    }
    return { state: "configured_multi", configs, source: "file" };
  }

  // ── Single-workspace format: { "workspaceId": "...", "authCookie": "..." } ──
  const cfg = normalizeWorkspaceConfig(raw);
  if (cfg) {
    return { state: "configured", config: cfg, source: "file" };
  }

  return null;
}

// =============================================================================
// Primary resolution (env first, then file)
// =============================================================================

export async function resolveOpenCodeGoConfig(): Promise<ResolvedOpenCodeGoConfig> {
  // Env takes priority — supports both single and multi
  const envMulti = resolveMultiFromEnv();
  if (envMulti) return envMulti;

  // Fall back to JSON config file
  const candidates = getConfigCandidatePaths();
  for (const path of candidates) {
    const fileResult = await readConfigFile(path);
    if (fileResult.state === "missing") continue;
    if (fileResult.state === "invalid") {
      return { state: "invalid", source: path, error: fileResult.error };
    }

    const parsed = parseConfigFile(fileResult.config);
    if (parsed) {
      // Override source to include the actual file path
      if (parsed.state === "configured") {
        return { state: "configured", config: parsed.config, source: path };
      }
      if (parsed.state === "configured_multi") {
        return { state: "configured_multi", configs: parsed.configs, source: path };
      }
    }

    // File loaded but no valid config found — check for incomplete fields
    const workspaceId = typeof fileResult.config.workspaceId === "string" ? fileResult.config.workspaceId.trim() : "";
    const authCookie = typeof fileResult.config.authCookie === "string" ? fileResult.config.authCookie.trim() : "";
    const missing = !workspaceId ? "workspaceId (and no workspaces array)" : "authCookie";
    return { state: "incomplete", source: path, missing };
  }

  return { state: "none" };
}

// =============================================================================
// Cache
// =============================================================================

let cachedConfig: ResolvedOpenCodeGoConfig | null = null;
let cachedAt = 0;

const DEFAULT_CACHE_MAX_AGE_MS = 30_000;
export { DEFAULT_CACHE_MAX_AGE_MS as DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS };

export async function resolveOpenCodeGoConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeGoConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }
  cachedConfig = await resolveOpenCodeGoConfig();
  cachedAt = now;
  return cachedConfig;
}

// =============================================================================
// Multi-config helper
// =============================================================================

/**
 * Resolve all configured OpenCode Go workspaces as a flat list.
 *
 * For single-workspace configs, returns a single-element array.
 * For multi-workspace configs, returns all configured workspaces.
 * For none/incomplete/invalid, returns an empty array.
 *
 * This is the primary API for consumers that want to iterate over workspaces.
 */
export async function resolveAllOpenCodeGoConfigs(): Promise<OpenCodeGoConfig[]> {
  const resolved = await resolveOpenCodeGoConfigCached();
  if (resolved.state === "configured") {
    return [resolved.config];
  }
  if (resolved.state === "configured_multi") {
    return resolved.configs;
  }
  return [];
}

// =============================================================================
// Diagnostics
// =============================================================================

export async function getOpenCodeGoConfigDiagnostics(): Promise<OpenCodeGoConfigDiagnostics> {
  const resolved = await resolveOpenCodeGoConfig();
  const checkedPaths = getConfigCandidatePaths();

  const workspaceCount =
    resolved.state === "configured" ? 1
    : resolved.state === "configured_multi" ? resolved.configs.length
    : 0;

  if (resolved.state === "none") {
    return { state: "none", source: null, missing: null, error: null, checkedPaths, workspaceCount };
  }

  if (resolved.state === "incomplete") {
    return {
      state: "incomplete",
      source: resolved.source,
      missing: resolved.missing,
      error: null,
      checkedPaths,
      workspaceCount,
    };
  }

  if (resolved.state === "invalid") {
    return {
      state: "invalid",
      source: resolved.source,
      missing: null,
      error: resolved.error,
      checkedPaths,
      workspaceCount,
    };
  }

  return {
    state: resolved.state,
    source: resolved.source,
    missing: null,
    error: null,
    checkedPaths,
    workspaceCount,
  };
}
