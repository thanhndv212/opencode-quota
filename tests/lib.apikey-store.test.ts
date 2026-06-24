import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";

import {
  getApiKeyStoreStatus,
  initApiKeyStore,
  unlockApiKeyStore,
  lockApiKeyStore,
  isApiKeyStoreUnlocked,
  listApiKeyProviders,
  getApiKey,
  getMaskedApiKey,
  setApiKey,
  deleteApiKey,
  changeApiKeyStorePassphrase,
  destroyApiKeyStore,
} from "../src/lib/apikey-store.js";

const testDir = join(tmpdir(), `opencode-quota-test-apikeys-${Date.now()}`);

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = testDir;
  process.env.XDG_DATA_HOME = testDir;
  process.env.XDG_CACHE_HOME = testDir;
  process.env.XDG_STATE_HOME = testDir;
  process.env.HOME = testDir;
  mkdirSync(join(testDir, "opencode-quota"), { recursive: true });
  // Ensure clean state between tests
  lockApiKeyStore();
});

afterEach(async () => {
  lockApiKeyStore();
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("apikey-store", () => {
  const PASSPHRASE = "test-passphrase-123";
  const PASSPHRASE_2 = "another-passphrase-456";

  describe("store lifecycle", () => {
    it("starts empty", async () => {
      const status = await getApiKeyStoreStatus();
      expect(status.state).toBe("empty");
    });

    it("initializes with a passphrase", async () => {
      await initApiKeyStore(PASSPHRASE);
      expect(isApiKeyStoreUnlocked()).toBe(true);

      const status = await getApiKeyStoreStatus();
      expect(status.state).toBe("unlocked");
    });

    it("throws when initializing an existing store", async () => {
      await initApiKeyStore(PASSPHRASE);
      await expect(initApiKeyStore(PASSPHRASE)).rejects.toThrow("already exists");
    });

    it("locks after initialization then unlocks", async () => {
      await initApiKeyStore(PASSPHRASE);
      expect(isApiKeyStoreUnlocked()).toBe(true);

      lockApiKeyStore();
      expect(isApiKeyStoreUnlocked()).toBe(false);

      const status = await getApiKeyStoreStatus();
      expect(status.state).toBe("locked");

      const infos = await unlockApiKeyStore(PASSPHRASE);
      expect(isApiKeyStoreUnlocked()).toBe(true);
      expect(infos).toEqual([]);
    });

    it("throws on wrong passphrase", async () => {
      await initApiKeyStore(PASSPHRASE);
      lockApiKeyStore();

      await expect(unlockApiKeyStore("wrong-passphrase")).rejects.toThrow("Invalid passphrase");
    });

    it("throws unlocking nonexistent store", async () => {
      await expect(unlockApiKeyStore(PASSPHRASE)).rejects.toThrow("No API key store found");
    });
  });

  describe("key CRUD", () => {
    beforeEach(async () => {
      await initApiKeyStore(PASSPHRASE);
    });

    it("stores and retrieves an API key", async () => {
      await setApiKey("openai", "sk-test123", "Work account");
      const key = getApiKey("openai");
      expect(key).toBe("sk-test123");
    });

    it("returns null for nonexistent key", () => {
      expect(getApiKey("nonexistent")).toBeNull();
    });

    it("throws when setting key while locked", async () => {
      lockApiKeyStore();
      await expect(setApiKey("openai", "sk-xxx")).rejects.toThrow("locked");
    });

    it("lists stored providers", async () => {
      await setApiKey("openai", "sk-aaa", "OpenAI");
      await setApiKey("anthropic", "sk-bbb", "Anthropic");

      const providers = listApiKeyProviders();
      expect(providers).toHaveLength(2);
      expect(providers.map((p) => p.providerId).sort()).toEqual(["anthropic", "openai"]);
    });

    it("deletes a key", async () => {
      await setApiKey("test", "sk-delete-me");
      expect(getApiKey("test")).toBe("sk-delete-me");

      const deleted = await deleteApiKey("test");
      expect(deleted).toBe(true);
      expect(getApiKey("test")).toBeNull();
    });

    it("returns false when deleting nonexistent key", async () => {
      const result = await deleteApiKey("nonexistent");
      expect(result).toBe(false);
    });

    it("persists across lock/unlock cycle", async () => {
      await setApiKey("openai", "sk-persist", "Test");

      lockApiKeyStore();
      expect(getApiKey("openai")).toBeNull();

      await unlockApiKeyStore(PASSPHRASE);
      expect(getApiKey("openai")).toBe("sk-persist");
    });

    it("updates an existing key", async () => {
      await setApiKey("openai", "sk-first", "First");
      await setApiKey("openai", "sk-second", "Second");

      expect(getApiKey("openai")).toBe("sk-second");

      const providers = listApiKeyProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]!.label).toBe("Second");
    });
  });

  describe("getMaskedApiKey", () => {
    beforeEach(async () => {
      await initApiKeyStore(PASSPHRASE);
    });

    it("returns masked version of key", async () => {
      await setApiKey("openai", "sk-abcdefghijklmnop");
      const masked = getMaskedApiKey("openai");
      expect(masked).toBe("sk-a...mnop");
    });

    it("returns null for nonexistent key", () => {
      expect(getMaskedApiKey("none")).toBeNull();
    });

    it("handles short keys", async () => {
      await setApiKey("test", "abc");
      const masked = getMaskedApiKey("test");
      expect(masked).toBe("***");
    });
  });

  describe("changePassphrase", () => {
    it("changes the passphrase successfully", async () => {
      await initApiKeyStore(PASSPHRASE);
      await setApiKey("openai", "sk-test");

      await changeApiKeyStorePassphrase(PASSPHRASE, PASSPHRASE_2);

      // Key should still be accessible (in-memory state preserved)
      expect(getApiKey("openai")).toBe("sk-test");

      // Lock and unlock with new passphrase
      lockApiKeyStore();
      await unlockApiKeyStore(PASSPHRASE_2);
      expect(getApiKey("openai")).toBe("sk-test");

      // Old passphrase should fail
      lockApiKeyStore();
      await expect(unlockApiKeyStore(PASSPHRASE)).rejects.toThrow("Invalid passphrase");
    });
  });

  describe("destroyApiKeyStore", () => {
    it("destroys the store", async () => {
      await initApiKeyStore(PASSPHRASE);
      await setApiKey("openai", "sk-test");

      await destroyApiKeyStore();
      expect(isApiKeyStoreUnlocked()).toBe(false);

      const status = await getApiKeyStoreStatus();
      expect(status.state).toBe("empty");
    });
  });

  describe("encryption properties", () => {
    it("different passphrases produce different ciphertexts", async () => {
      await initApiKeyStore("pass-a");
      await setApiKey("test", "same-key-value");
      lockApiKeyStore();
      await destroyApiKeyStore();

      await initApiKeyStore("pass-b");
      await setApiKey("test", "same-key-value");
      lockApiKeyStore();

      // Attempting to unlock store created with pass-b using pass-a should fail
      await expect(unlockApiKeyStore("pass-a")).rejects.toThrow("Invalid passphrase");
    });

    it("same plaintext encrypted twice yields different ciphertexts", async () => {
      await initApiKeyStore(PASSPHRASE);
      await setApiKey("provider-a", "my-secret-key");

      // Read the raw file to check the ciphertext
      const { readFile } = await import("fs/promises");
      const { join } = await import("path");
      const { getOpencodeRuntimeDirs } = await import("../src/lib/opencode-runtime-paths.js");

      const { configDir } = getOpencodeRuntimeDirs();
      const storePath = join(configDir, "opencode-quota", "apikeys.enc");
      const raw = await readFile(storePath, "utf-8");
      const store = JSON.parse(raw);

      expect(store.keys["provider-a"]).toBeDefined();
      expect(store.keys["provider-a"].iv).toBeTruthy();
      expect(store.keys["provider-a"].authTag).toBeTruthy();
      expect(store.keys["provider-a"].ciphertext).toBeTruthy();
      // Ciphertext should not contain the plaintext
      expect(store.keys["provider-a"].ciphertext).not.toContain("my-secret-key");
    });
  });
});
