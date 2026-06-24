/**
 * GUI application configuration persistence.
 *
 * Stores window position, theme, auto-start preference, refresh interval,
 * and other GUI-specific settings. Persisted in the OpenCode config directory
 * alongside other plugin configuration.
 *
 * File: ~/.config/opencode-quota/gui-config.json
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

// =============================================================================
// Constants
// =============================================================================

export const GUI_CONFIG_VERSION = 1 as const;
export const GUI_CONFIG_DIRNAME = "opencode-quota";
export const GUI_CONFIG_FILENAME = "gui-config.json";

// =============================================================================
// Types
// =============================================================================

export type GuiTheme = "dark" | "light" | "system";

export interface GuiWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface GuiConfig {
  version: typeof GUI_CONFIG_VERSION;

  /** UI theme preference */
  theme: GuiTheme;

  /** Auto-launch the menubar app on system login */
  launchAtLogin: boolean;

  /** Auto-refresh interval in milliseconds (default: 300000 = 5 min) */
  refreshIntervalMs: number;

  /** Remembered window bounds for the popup */
  windowBounds: GuiWindowBounds;

  /** Last active tab index (0 = Dashboard, 1 = Token Usage, 2 = Budget Alerts, 3 = Pricing, 4 = API Keys, 5 = Settings) */
  lastActiveTab: number;

  /** Default time window for token usage display */
  defaultTokenWindow: "day" | "week" | "month" | "all";

  /** Default grouping for token usage display */
  defaultTokenGroupBy: "model" | "provider" | "project";

  /** Show menubar badge on budget alert */
  showAlertBadge: boolean;

  /** When this config was last updated (epoch ms) */
  updatedAt: number;
}

// =============================================================================
// Defaults
// =============================================================================

export const DEFAULT_GUI_CONFIG: GuiConfig = {
  version: GUI_CONFIG_VERSION,
  theme: "dark",
  launchAtLogin: false,
  refreshIntervalMs: 5 * 60 * 1000, // 5 minutes
  windowBounds: {
    width: 420,
    height: 600,
  },
  lastActiveTab: 0,
  defaultTokenWindow: "week",
  defaultTokenGroupBy: "model",
  showAlertBadge: true,
  updatedAt: 0,
};

// =============================================================================
// In-memory cache
// =============================================================================

let cachedConfig: GuiConfig | null = null;
let configLoadedAt = 0;
const CONFIG_CACHE_TTL_MS = 30_000;

// =============================================================================
// Path resolution
// =============================================================================

function getGuiConfigFilePath(): string {
  const { configDir } = getOpencodeRuntimeDirs();
  return join(configDir, GUI_CONFIG_DIRNAME, GUI_CONFIG_FILENAME);
}

// =============================================================================
// I/O
// =============================================================================

async function loadConfig(forceReload = false): Promise<GuiConfig> {
  const now = Date.now();
  if (!forceReload && cachedConfig && now - configLoadedAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  const filePath = getGuiConfigFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version) {
      cachedConfig = { ...DEFAULT_GUI_CONFIG, ...parsed, version: GUI_CONFIG_VERSION };
    } else {
      cachedConfig = { ...DEFAULT_GUI_CONFIG };
    }
  } catch {
    cachedConfig = { ...DEFAULT_GUI_CONFIG };
  }
  configLoadedAt = now;
  return cachedConfig!;
}

async function saveConfig(config: GuiConfig): Promise<void> {
  const filePath = getGuiConfigFilePath();
  const toSave: GuiConfig = { ...config, updatedAt: Date.now() };
  await writeJsonAtomic(filePath, toSave, { trailingNewline: true });
  cachedConfig = toSave;
  configLoadedAt = Date.now();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the full GUI configuration.
 */
export async function getGuiConfig(): Promise<GuiConfig> {
  return loadConfig();
}

/**
 * Get a single config value by key.
 */
export async function getGuiConfigValue<K extends keyof GuiConfig>(key: K): Promise<GuiConfig[K]> {
  const config = await loadConfig();
  return config[key];
}

/**
 * Update the GUI configuration (partial update).
 */
export async function updateGuiConfig(patch: Partial<GuiConfig>): Promise<GuiConfig> {
  const config = await loadConfig(true);
  const updated: GuiConfig = { ...config, ...patch, version: GUI_CONFIG_VERSION, updatedAt: Date.now() };
  await saveConfig(updated);
  return updated;
}

/**
 * Reset the GUI configuration to defaults.
 */
export async function resetGuiConfig(): Promise<GuiConfig> {
  const defaults = { ...DEFAULT_GUI_CONFIG, updatedAt: Date.now() };
  await saveConfig(defaults);
  return defaults;
}

/**
 * Update just the window bounds after resize/move.
 */
export async function updateWindowBounds(bounds: Partial<GuiWindowBounds>): Promise<void> {
  const config = await loadConfig();
  config.windowBounds = { ...config.windowBounds, ...bounds };
  await saveConfig(config);
}

/**
 * Invalidate the in-memory cache.
 */
export function clearGuiConfigCache(): void {
  cachedConfig = null;
  configLoadedAt = 0;
}
