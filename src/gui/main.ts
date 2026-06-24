#!/usr/bin/env node
/**
 * OpenCode Quota — Menubar GUI App
 *
 * A minimal, cross-platform (macOS + Linux) menubar/tray app that
 * visualizes quota, token usage, pricing, budget alerts, and API keys.
 *
 * Usage:
 *   opencode-quota-gui              # Launch the menubar app
 *   opencode-quota gui              # Alternative invocation
 */

import { app, BrowserWindow, ipcMain, nativeImage, Tray, Menu, dialog } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

import type { QuotaToastConfig } from "../lib/types.js";
import { DEFAULT_CONFIG } from "../lib/types.js";
import { getGuiConfig, updateGuiConfig, updateWindowBounds, type GuiConfig } from "../lib/gui-config.js";
import { preloadUserPricing } from "../lib/user-pricing.js";
import { preloadBudgetAlerts } from "../lib/budget-alerts.js";

// IPC handlers
import * as quotaIpc from "./ipc/quota.js";
import * as tokensIpc from "./ipc/tokens.js";
import * as pricingIpc from "./ipc/pricing.js";
import * as alertsIpc from "./ipc/alerts.js";
import * as apikeysIpc from "./ipc/apikeys.js";

// =============================================================================
// Constants
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_NAME = "OpenCode Quota";
const RENDERER_HTML = "renderer/index.html";

// =============================================================================
// Path resolution (handles both dev and packaged modes)
// =============================================================================

function getAppRoot(): string {
  // In development: __dirname = dist/gui/, root = dist/
  // In packaged:    __dirname = app.asar/dist/gui/, root = app.asar/dist/
  if (app.isPackaged) {
    return path.join(app.getAppPath(), "dist");
  }
  return path.join(__dirname, "..");
}

function resolveRendererPath(): string {
  // In packaged mode, renderer files are in the app resources
  if (app.isPackaged) {
    const packagedPath = path.join(process.resourcesPath, "renderer", "index.html");
    if (existsSync(packagedPath)) return packagedPath;
  }

  // Development: try dist/gui/renderer/ then src/gui/renderer/
  const distPath = path.join(__dirname, RENDERER_HTML);
  if (existsSync(distPath)) return distPath;

  const srcPath = path.join(__dirname, "..", "src", "gui", RENDERER_HTML);
  if (existsSync(srcPath)) return srcPath;

  return "";
}

function resolvePreloadPath(): string {
  // In packaged mode, preload is inside the asar
  const preloadPath = path.join(__dirname, "preload.js");
  if (existsSync(preloadPath)) return preloadPath;

  // Fallback for development
  return preloadPath;
}

function resolvePackageJsonPath(): string {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), "package.json");
  }
  return path.join(getAppRoot(), "package.json");
}

// =============================================================================
// Icon generation (simple programmatic icon)
// =============================================================================

function createTrayIcon(): Electron.NativeImage {
  // Create a simple 16x16 icon with a small circle/dot
  // In production, this would be a proper PNG file
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  // Draw a simple "Q" shape (filled circle)
  const cx = size / 2;
  const cy = size / 2;
  const r = 5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= r) {
        canvas[idx] = 100;     // R
        canvas[idx + 1] = 200; // G
        canvas[idx + 2] = 255; // B
        canvas[idx + 3] = 255; // A
      } else {
        canvas[idx + 3] = 0;   // transparent
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size,
  });
}

// =============================================================================
// Configuration loading
// =============================================================================

async function loadQuotaConfig(): Promise<QuotaToastConfig> {
  // In a real scenario, load from the same config files as the plugin
  // For the GUI standalone mode, we use defaults + potentially a separate config
  return { ...DEFAULT_CONFIG };
}

// =============================================================================
// IPC handler registration
// =============================================================================

function registerIpcHandlers(config: QuotaToastConfig, guiConfig: GuiConfig) {
  // ── Quota ──────────────────────────────────────────
  ipcMain.handle("quota:fetch", async (_event, params: { bypassCache?: boolean }) => {
    try {
      const result = await quotaIpc.fetchAllQuota(config, params?.bypassCache);
      return result;
    } catch (err) {
      return {
        entries: [],
        errors: [{ label: "quota", message: err instanceof Error ? err.message : String(err) }],
        detectedProviderIds: [],
      };
    }
  });

  // ── Token Usage ────────────────────────────────────
  ipcMain.handle("tokens:query", async (_event, params: Record<string, unknown>) => {
    try {
      return await tokensIpc.queryTokenUsage({
        windowMs: params.windowMs as number | undefined,
        window: params.window as tokensIpc.TokensQueryParams["window"],
        sinceMs: params.sinceMs as number | undefined,
        untilMs: params.untilMs as number | undefined,
      });
    } catch (err) {
      throw err;
    }
  });

  ipcMain.handle("tokens:projects", async () => {
    return tokensIpc.getProjectsWithUsage();
  });

  // ── Pricing ────────────────────────────────────────
  ipcMain.handle("pricing:list", async () => {
    return pricingIpc.listPricing();
  });

  ipcMain.handle("pricing:save", async (_event, params: {
    provider: string;
    model: string;
    rates: Record<string, number | undefined>;
    label?: string;
  }) => {
    return pricingIpc.savePricingOverride({
      provider: params.provider,
      model: params.model,
      rates: params.rates,
      label: params.label,
    });
  });

  ipcMain.handle("pricing:delete", async (_event, params: { provider: string; model: string }) => {
    return pricingIpc.deletePricingOverride(params.provider, params.model);
  });

  ipcMain.handle("pricing:refresh", async () => {
    return pricingIpc.refreshPricingSnapshot();
  });

  ipcMain.handle("pricing:listProviders", async () => {
    return pricingIpc.listSnapshotProviders();
  });

  ipcMain.handle("pricing:listModels", async (_event, params: { provider: string }) => {
    return pricingIpc.listSnapshotModels(params.provider);
  });

  // ── Budget Alerts ──────────────────────────────────
  ipcMain.handle("alerts:list", async () => {
    return alertsIpc.listAlerts();
  });

  ipcMain.handle("alerts:create", async (_event, params: Record<string, unknown>) => {
    return alertsIpc.createAlert({
      name: params.name as string,
      scope: params.scope as { type: "global" | "provider" | "model"; providerId?: string; modelId?: string },
      window: params.window as "day" | "week" | "month" | "all",
      metric: params.metric as "cost_usd" | "tokens_total" | "tokens_input" | "tokens_output",
      threshold: params.threshold as number,
      direction: params.direction as "above" | "below",
      enabled: params.enabled as boolean | undefined,
    });
  });

  ipcMain.handle("alerts:update", async (_event, params: { id: string; params: Record<string, unknown> }) => {
    return alertsIpc.updateAlert(params.id, params.params);
  });

  ipcMain.handle("alerts:delete", async (_event, params: { id: string }) => {
    return alertsIpc.deleteAlert(params.id);
  });

  ipcMain.handle("alerts:eval", async (_event, params: { usageMap: Array<{ key: string; usage: unknown }> }) => {
    return alertsIpc.evaluateAlerts(params.usageMap as Array<{ key: string; usage: Parameters<typeof alertsIpc.evaluateAlerts>[0][number]["usage"] }>);
  });

  // ── API Keys ───────────────────────────────────────
  ipcMain.handle("apikeys:status", async () => apikeysIpc.getStatus());
  ipcMain.handle("apikeys:init", async (_e, p: { passphrase: string }) => apikeysIpc.initStore(p.passphrase));
  ipcMain.handle("apikeys:unlock", async (_e, p: { passphrase: string }) => apikeysIpc.unlockStore(p.passphrase));
  ipcMain.handle("apikeys:lock", () => { apikeysIpc.lockStore(); });
  ipcMain.handle("apikeys:isUnlocked", () => apikeysIpc.isUnlocked());
  ipcMain.handle("apikeys:list", () => apikeysIpc.listKeys());
  ipcMain.handle("apikeys:get", (_e, p: { providerId: string }) => apikeysIpc.getKey(p.providerId));
  ipcMain.handle("apikeys:getMasked", (_e, p: { providerId: string }) => apikeysIpc.getMasked(p.providerId));
  ipcMain.handle("apikeys:save", async (_e, p: { providerId: string; apiKey: string; label?: string }) => apikeysIpc.saveKey(p.providerId, p.apiKey, p.label));
  ipcMain.handle("apikeys:delete", async (_e, p: { providerId: string }) => apikeysIpc.removeKey(p.providerId));
  ipcMain.handle("apikeys:changePassphrase", async (_e, p: { oldPassphrase: string; newPassphrase: string }) => apikeysIpc.changePassphrase(p.oldPassphrase, p.newPassphrase));
  ipcMain.handle("apikeys:export", async (_e, p: { sharePassphrase: string }) => apikeysIpc.exportKeys(p.sharePassphrase));
  ipcMain.handle("apikeys:import", async (_e, p: { filePath: string; sharePassphrase: string }) => apikeysIpc.importKeys(p.filePath, p.sharePassphrase));

  // ── Config ─────────────────────────────────────────
  ipcMain.handle("config:get", async () => getGuiConfig());
  ipcMain.handle("config:update", async (_e, p: { patch: Record<string, unknown> }) => updateGuiConfig(p.patch as Partial<GuiConfig>));
  ipcMain.handle("config:reset", async () => {
    const { resetGuiConfig } = await import("../lib/gui-config.js");
    return resetGuiConfig();
  });

  // ── App ────────────────────────────────────────────
  ipcMain.handle("app:version", () => {
    try {
      const pkgPath = resolvePackageJsonPath();
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  });
  ipcMain.handle("app:quit", () => {
    app.quit();
  });
}

// =============================================================================
// Window management
// =============================================================================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function createWindow(guiConfig: GuiConfig): BrowserWindow {
  const preloadPath = resolvePreloadPath();
  const win = new BrowserWindow({
    width: guiConfig.windowBounds.width,
    height: guiConfig.windowBounds.height,
    x: guiConfig.windowBounds.x,
    y: guiConfig.windowBounds.y,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the renderer
  const htmlPath = resolveRendererPath();
  if (htmlPath && existsSync(htmlPath)) {
    win.loadFile(htmlPath);
  } else {
    win.loadURL(`data:text/html,<h1>${APP_NAME}</h1><p>Renderer not found at: ${htmlPath || '(no path)'}</p>`);
  }

  win.on("blur", () => {
    // Hide window when it loses focus (menubar behavior)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  win.on("resize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      updateWindowBounds({ width: bounds.width, height: bounds.height });
    }
  });

  win.on("move", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      updateWindowBounds({ x: bounds.x, y: bounds.y });
    }
  });

  return win;
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    // Position near the tray icon
    if (tray) {
      const trayBounds = tray.getBounds();
      const windowBounds = mainWindow.getBounds();

      // Center below the tray icon (macOS) or above (Linux)
      const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
      const isMacOS = process.platform === "darwin";
      const y = isMacOS ? trayBounds.y + trayBounds.height : trayBounds.y - windowBounds.height;

      mainWindow.setPosition(x, y);
    }

    mainWindow.show();
    mainWindow.focus();
  }
}

// =============================================================================
// App lifecycle
// =============================================================================

app.whenReady().then(async () => {
  // Load configuration
  const guiConfig = await getGuiConfig();
  const quotaConfig = await loadQuotaConfig();

  // Preload caches
  await preloadUserPricing();
  await preloadBudgetAlerts();

  // Register IPC handlers
  registerIpcHandlers(quotaConfig, guiConfig);

  // Create tray icon
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  // Create tray context menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Refresh Quota",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("app:refresh");
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // Toggle window on tray click
  tray.on("click", () => {
    toggleWindow();
  });

  // Create the popup window
  mainWindow = createWindow(guiConfig);

  // Prevent window from being closed — hide instead
  mainWindow.on("close", (event: Electron.Event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
      event.preventDefault();
    }
  });

  // Show initially
  mainWindow.show();
});

// Prevent app from quitting when all windows are hidden
app.on("window-all-closed", () => {
  // Don't quit — keep running in tray
});

// macOS: re-create window on activate
app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    getGuiConfig().then((cfg) => {
      mainWindow = createWindow(cfg);
      mainWindow?.show();
    });
  } else {
    mainWindow.show();
  }
});

app.on("before-quit", () => {
  // Cleanup
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
  mainWindow = null;
});
