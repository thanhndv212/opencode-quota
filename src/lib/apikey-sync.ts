/**
 * Cross-machine sharing for encrypted API keys.
 *
 * Uses a one-time share passphrase for export/import of encrypted key bundles.
 * The flow:
 *   1. Export: local keys are decrypted → re-encrypted with share passphrase → written to .share file
 *   2. Import: .share file is decrypted with share passphrase → merged into local store (re-encrypted with local master key)
 *
 * Share file format is self-contained with its own salt, so the share passphrase
 * is the only thing needed to decrypt it on any machine.
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "crypto";
import { readFile, rm } from "fs/promises";
import { writeJsonAtomic } from "./atomic-json.js";

// =============================================================================
// Constants
// =============================================================================

export const APIKEY_SHARE_VERSION = 1 as const;
export const APIKEY_SHARE_DEFAULT_FILENAME = "opencode-quota-apikeys.share";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = "sha512";

// =============================================================================
// Types
// =============================================================================

export interface ApiKeyShareEntry {
  providerId: string;
  label: string;
  /** The plaintext API key value (encrypted in the share file wrapper) */
  key: string;
}

export interface ApiKeyShareBundle {
  version: typeof APIKEY_SHARE_VERSION;
  /** Base64-encoded salt (32 bytes) used to derive the key from the share passphrase */
  salt: string;
  /** When this bundle was created (ISO-8601) */
  exportedAt: string;
  /** Encrypted entries */
  entries: ApiKeyShareEncryptedEntry[];
}

export interface ApiKeyShareEncryptedEntry {
  /** Base64-encoded IV (12 bytes) */
  iv: string;
  /** Base64-encoded auth tag (16 bytes) */
  authTag: string;
  /** Base64-encoded ciphertext (JSON-serialized ApiKeyShareEntry) */
  ciphertext: string;
}

export interface ApiKeyImportResult {
  /** Number of keys successfully imported */
  imported: number;
  /** Number of keys skipped (already exist with same value) */
  skipped: number;
  /** Provider IDs that were imported */
  providerIds: string[];
}

// =============================================================================
// Crypto helpers (local, not shared with apikey-store.ts to keep modules decoupled)
// =============================================================================

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function encryptValue(key: Buffer, plaintext: string): { iv: string; authTag: string; ciphertext: string } {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

function decryptValue(key: Buffer, ivB64: string, authTagB64: string, ciphertextB64: string): string {
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}

// =============================================================================
// Export
// =============================================================================

/**
 * Create an encrypted share bundle from a list of plaintext API key entries.
 *
 * @param entries - The API keys to share (providerId, label, plaintext key)
 * @param sharePassphrase - One-time passphrase to encrypt the share bundle
 * @returns The share bundle (ready to write to a file)
 */
export async function createApiKeyShareBundle(
  entries: ApiKeyShareEntry[],
  sharePassphrase: string,
): Promise<ApiKeyShareBundle> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(sharePassphrase, salt);

  const encryptedEntries: ApiKeyShareEncryptedEntry[] = [];
  for (const entry of entries) {
    const plaintext = JSON.stringify(entry);
    const encrypted = encryptValue(key, plaintext);
    encryptedEntries.push(encrypted);
  }

  return {
    version: APIKEY_SHARE_VERSION,
    salt: salt.toString("base64"),
    exportedAt: new Date().toISOString(),
    entries: encryptedEntries,
  };
}

/**
 * Write a share bundle to a file.
 */
export async function writeApiKeyShareBundle(
  filePath: string,
  bundle: ApiKeyShareBundle,
): Promise<void> {
  await writeJsonAtomic(filePath, bundle, { trailingNewline: true });
}

/**
 * Decrypt a share bundle and return the plaintext entries.
 *
 * @param bundle - The share bundle to decrypt
 * @param sharePassphrase - The passphrase used to encrypt the bundle
 * @returns Array of plaintext API key entries
 */
export async function decryptApiKeyShareBundle(
  bundle: ApiKeyShareBundle,
  sharePassphrase: string,
): Promise<ApiKeyShareEntry[]> {
  const salt = Buffer.from(bundle.salt, "base64");
  const key = await deriveKey(sharePassphrase, salt);

  const entries: ApiKeyShareEntry[] = [];
  for (const encrypted of bundle.entries) {
    try {
      const plaintext = decryptValue(key, encrypted.iv, encrypted.authTag, encrypted.ciphertext);
      const entry = JSON.parse(plaintext) as ApiKeyShareEntry;
      entries.push(entry);
    } catch {
      // Skip corrupted/unreadable entries
      continue;
    }
  }

  return entries;
}

/**
 * Read a share bundle from a file.
 */
export async function readApiKeyShareBundle(filePath: string): Promise<ApiKeyShareBundle | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === APIKEY_SHARE_VERSION &&
      typeof parsed.salt === "string" &&
      Array.isArray(parsed.entries)
    ) {
      return parsed as ApiKeyShareBundle;
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Import helpers (caller provides the merge logic)
// =============================================================================

/**
 * Import entries from a share file into the local store.
 *
 * @param shareFilePath - Path to the .share file
 * @param sharePassphrase - Passphrase to decrypt the share file
 * @param getLocalKey - Function to check if a key already exists locally (return existing plaintext or null)
 * @param setLocalKey - Function to store an imported key locally
 * @returns Import result with counts
 */
export async function importApiKeyShareFile(
  shareFilePath: string,
  sharePassphrase: string,
  getLocalKey: (providerId: string) => string | null,
  setLocalKey: (providerId: string, apiKey: string, label: string) => Promise<void>,
): Promise<ApiKeyImportResult> {
  const bundle = await readApiKeyShareBundle(shareFilePath);
  if (!bundle) {
    throw new Error("Invalid or missing share file.");
  }

  const entries = await decryptApiKeyShareBundle(bundle, sharePassphrase);
  if (entries.length === 0) {
    throw new Error("Share file is empty or could not be decrypted.");
  }

  let imported = 0;
  let skipped = 0;
  const providerIds: string[] = [];

  for (const entry of entries) {
    const existing = getLocalKey(entry.providerId);

    if (existing === entry.key) {
      skipped++;
      continue;
    }

    await setLocalKey(entry.providerId, entry.key, entry.label);
    imported++;
    providerIds.push(entry.providerId);
  }

  return { imported, skipped, providerIds };
}

/**
 * Clean up a share file after import.
 */
export async function deleteApiKeyShareFile(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch {
    // best-effort
  }
}
