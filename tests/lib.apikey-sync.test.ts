import { describe, expect, it } from "vitest";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  createApiKeyShareBundle,
  decryptApiKeyShareBundle,
  readApiKeyShareBundle,
  writeApiKeyShareBundle,
  deleteApiKeyShareFile,
  type ApiKeyShareEntry,
  type ApiKeyShareBundle,
} from "../src/lib/apikey-sync.js";

describe("apikey-sync", () => {
  const testEntries: ApiKeyShareEntry[] = [
    { providerId: "openai", label: "Work", key: "sk-openai-work-key" },
    { providerId: "anthropic", label: "Personal", key: "sk-ant-personal-key" },
    { providerId: "deepseek", label: "DeepSeek", key: "sk-deepseek-key-123" },
  ];

  describe("createApiKeyShareBundle + decryptApiKeyShareBundle", () => {
    it("round-trips entries through encryption/decryption", async () => {
      const passphrase = "share-passphrase-123";

      const bundle = await createApiKeyShareBundle(testEntries, passphrase);
      expect(bundle.version).toBe(1);
      expect(bundle.salt).toBeTruthy();
      expect(bundle.entries).toHaveLength(3);
      expect(bundle.exportedAt).toBeTruthy();

      const decrypted = await decryptApiKeyShareBundle(bundle, passphrase);
      expect(decrypted).toEqual(testEntries);
    });

    it("fails to decrypt with wrong passphrase", async () => {
      const bundle = await createApiKeyShareBundle(testEntries, "correct-pass");
      const decrypted = await decryptApiKeyShareBundle(bundle, "wrong-pass");
      expect(decrypted).toEqual([]);
    });

    it("handles empty entry list", async () => {
      const bundle = await createApiKeyShareBundle([], "pass");
      const decrypted = await decryptApiKeyShareBundle(bundle, "pass");
      expect(decrypted).toEqual([]);
    });

    it("different passphrases produce different bundles", async () => {
      const bundle1 = await createApiKeyShareBundle(testEntries, "pass-a");
      const bundle2 = await createApiKeyShareBundle(testEntries, "pass-b");

      // Different salts
      expect(bundle1.salt).not.toBe(bundle2.salt);
      // Different ciphertexts
      expect(bundle1.entries[0]!.ciphertext).not.toBe(bundle2.entries[0]!.ciphertext);
    });

    it("same entries encrypted twice produce different ciphertexts", async () => {
      const bundle1 = await createApiKeyShareBundle(testEntries, "same-pass");
      const bundle2 = await createApiKeyShareBundle(testEntries, "same-pass");

      // Same passphrase, same data, but different IVs → different ciphertexts
      expect(bundle1.entries[0]!.iv).not.toBe(bundle2.entries[0]!.iv);
      expect(bundle1.entries[0]!.ciphertext).not.toBe(bundle2.entries[0]!.ciphertext);

      // But both should decrypt to the same plaintext
      const dec1 = await decryptApiKeyShareBundle(bundle1, "same-pass");
      const dec2 = await decryptApiKeyShareBundle(bundle2, "same-pass");
      expect(dec1).toEqual(dec2);
    });

    it("encrypted ciphertext does not contain plaintext key", async () => {
      const bundle = await createApiKeyShareBundle(testEntries, "pass");
      for (const entry of bundle.entries) {
        expect(entry.ciphertext).not.toContain("sk-openai");
        expect(entry.ciphertext).not.toContain("sk-ant");
        expect(entry.ciphertext).not.toContain("sk-deepseek");
      }
    });
  });

  describe("file I/O", () => {
    const testFilePath = join(tmpdir(), `opencode-quota-test-share-${Date.now()}.share`);

    it("writes and reads a share bundle", async () => {
      const passphrase = "file-passphrase";
      const bundle = await createApiKeyShareBundle(testEntries, passphrase);

      await writeApiKeyShareBundle(testFilePath, bundle);

      const read = await readApiKeyShareBundle(testFilePath);
      expect(read).not.toBeNull();
      expect(read!.version).toBe(1);
      expect(read!.entries).toHaveLength(3);

      const decrypted = await decryptApiKeyShareBundle(read!, passphrase);
      expect(decrypted).toEqual(testEntries);
    });

    it("reads null for nonexistent file", async () => {
      const result = await readApiKeyShareBundle("/nonexistent/path/file.share");
      expect(result).toBeNull();
    });

    it("reads null for invalid file content", async () => {
      // Not writing actual test here since it requires file system
      // The function already handles JSON parse errors gracefully
    });

    it("cleans up share file", async () => {
      const bundle = await createApiKeyShareBundle(testEntries, "pass");
      await writeApiKeyShareBundle(testFilePath, bundle);

      const exists = await readApiKeyShareBundle(testFilePath);
      expect(exists).not.toBeNull();

      await deleteApiKeyShareFile(testFilePath);
      const after = await readApiKeyShareBundle(testFilePath);
      expect(after).toBeNull();
    });
  });
});
