import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";

import {
  getGuiConfig,
  getGuiConfigValue,
  updateGuiConfig,
  resetGuiConfig,
  updateWindowBounds,
  clearGuiConfigCache,
  DEFAULT_GUI_CONFIG,
} from "../src/lib/gui-config.js";

const testDir = join(tmpdir(), `opencode-quota-test-gui-config-${Date.now()}`);

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = testDir;
  process.env.XDG_DATA_HOME = testDir;
  process.env.XDG_CACHE_HOME = testDir;
  process.env.XDG_STATE_HOME = testDir;
  process.env.HOME = testDir;
  mkdirSync(join(testDir, "opencode-quota"), { recursive: true });
  clearGuiConfigCache();
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("gui-config", () => {
  describe("defaults", () => {
    it("returns default config when no saved config exists", async () => {
      const config = await getGuiConfig();
      expect(config.theme).toBe(DEFAULT_GUI_CONFIG.theme);
      expect(config.launchAtLogin).toBe(DEFAULT_GUI_CONFIG.launchAtLogin);
      expect(config.refreshIntervalMs).toBe(DEFAULT_GUI_CONFIG.refreshIntervalMs);
      expect(config.windowBounds.width).toBe(DEFAULT_GUI_CONFIG.windowBounds.width);
    });
  });

  describe("updateGuiConfig", () => {
    it("updates a single field", async () => {
      const updated = await updateGuiConfig({ theme: "light" });
      expect(updated.theme).toBe("light");
      // Other fields remain at defaults
      expect(updated.launchAtLogin).toBe(DEFAULT_GUI_CONFIG.launchAtLogin);
    });

    it("updates multiple fields at once", async () => {
      const updated = await updateGuiConfig({
        theme: "system",
        launchAtLogin: true,
        refreshIntervalMs: 60000,
      });
      expect(updated.theme).toBe("system");
      expect(updated.launchAtLogin).toBe(true);
      expect(updated.refreshIntervalMs).toBe(60000);
    });

    it("persists across cache clears", async () => {
      await updateGuiConfig({ theme: "light" });
      clearGuiConfigCache();

      const config = await getGuiConfig();
      expect(config.theme).toBe("light");
    });

    it("updates the updatedAt timestamp", async () => {
      const before = await getGuiConfig();
      await new Promise((r) => setTimeout(r, 10));
      const after = await updateGuiConfig({ lastActiveTab: 3 });
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    });
  });

  describe("getGuiConfigValue", () => {
    it("gets a single config value", async () => {
      const theme = await getGuiConfigValue("theme");
      expect(theme).toBe(DEFAULT_GUI_CONFIG.theme);
    });
  });

  describe("updateWindowBounds", () => {
    it("updates window bounds partially", async () => {
      await updateWindowBounds({ width: 500, height: 700 });

      const config = await getGuiConfig();
      expect(config.windowBounds.width).toBe(500);
      expect(config.windowBounds.height).toBe(700);
    });

    it("preserves existing bounds when updating partially", async () => {
      await updateGuiConfig({
        windowBounds: { width: 400, height: 600, x: 100, y: 200 },
      });

      await updateWindowBounds({ width: 500 });

      const config = await getGuiConfig();
      expect(config.windowBounds.width).toBe(500);
      expect(config.windowBounds.height).toBe(600); // preserved
      expect(config.windowBounds.x).toBe(100); // preserved
      expect(config.windowBounds.y).toBe(200); // preserved
    });
  });

  describe("resetGuiConfig", () => {
    it("resets to defaults", async () => {
      await updateGuiConfig({
        theme: "light",
        launchAtLogin: true,
        lastActiveTab: 4,
      });

      const reset = await resetGuiConfig();
      expect(reset.theme).toBe(DEFAULT_GUI_CONFIG.theme);
      expect(reset.launchAtLogin).toBe(DEFAULT_GUI_CONFIG.launchAtLogin);
      expect(reset.lastActiveTab).toBe(DEFAULT_GUI_CONFIG.lastActiveTab);
    });
  });
});
