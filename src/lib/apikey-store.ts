/**
 * Encrypted API key store using AES-256-GCM with PBKDF2 key derivation.
 *
 * Design:
 * - Master passphrase → PBKDF2 (600K iter, SHA-512, random 32B salt) → 256-bit key
 * - Each API key encrypted individually with AES-256-GCM (random 12B IV per entry)
 * - Plaintext keys NEVER written to disk; only encrypted ciphertext persisted
 * - In-memory only when store is "unlocked"; cleared on lock
 *
 * Persisted at ~/.config/opencode-quota/apikeys.enc
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes, timingSafeEqual } from "crypto";
import { readFile, rm } from "fs/promises";
import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

// =============================================================================
// Constants
// =============================================================================

export const APIKEY_STORE_VERSION = 1 as const;
export const APIKEY_STORE_DIRNAME = "opencode-quota";
export const APIKEY_STORE_FILENAME = "apikeys.enc";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;          // 96 bits, recommended for GCM
const AUTH_TAG_LENGTH = 16;    // 128 bits
const SALT_LENGTH = 32;        // 256 bits
const KEY_LENGTH = 32;         // 256 bits for AES-256
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST = "sha512";

// =============================================================================
// Types
// =============================================================================

export interface EncryptedKeyEntry {
  /** Base64-encoded IV (12 bytes) */
  iv: string;
  /** Base64-encoded auth tag (16 bytes) */
  authTag: string;
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Provider ID this key belongs to */
  providerId: string;
  /** User-defined label (e.g. "Work account") */
  label: string;
  /** When this entry was created (epoch ms) */
  createdAt: number;
  /** When this entry was last updated (epoch ms) */
  updatedAt: number;
}

export interface ApiKeyStorePersisted {
  version: typeof APIKEY_STORE_VERSION;
  /** Base64-encoded salt (32 bytes) */
  salt: string;
  /** Map keyed by provider ID */
  keys: Record<string, EncryptedKeyEntry>;
}

export interface ApiKeyInfo {
  providerId: string;
  label: string;
  hasKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ApiKeyStoreStatus =
  | { state: "empty" }                     // No store file exists
  | { state: "locked"; providerCount: number }  // Store exists but is locked
  | { state: "unlocked"; providerCount: number; providers: ApiKeyInfo[] };  // Store is unlocked

// =============================================================================
// In-memory state (cleared on lock)
// =============================================================================

let derivedKey: Buffer | null = null;
let decryptedKeys: Map<string, string> | null = null;
let storeMetadata: Map<string, { label: string; createdAt: number; updatedAt: number }> | null = null;
let persistedSalt: string | null = null; // salt loaded from disk (needed for re-derivation after lock)

// =============================================================================
// Path resolution
// =============================================================================

function getStoreFilePath(): string {
  const { configDir } = getOpencodeRuntimeDirs();
  return join(configDir, APIKEY_STORE_DIRNAME, APIKEY_STORE_FILENAME);
}

// =============================================================================
// Crypto helpers
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
// Store I/O
// =============================================================================

async function readPersistedStore(): Promise<ApiKeyStorePersisted | null> {
  const filePath = getStoreFilePath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === APIKEY_STORE_VERSION &&
      typeof parsed.salt === "string" &&
      parsed.keys &&
      typeof parsed.keys === "object"
    ) {
      return parsed as ApiKeyStorePersisted;
    }
    return null;
  } catch {
    return null;
  }
}

async function writePersistedStore(store: ApiKeyStorePersisted): Promise<void> {
  const filePath = getStoreFilePath();
  await writeJsonAtomic(filePath, store, { trailingNewline: true });
}

// =============================================================================
// Store exists check
// =============================================================================

async function storeFileExists(): Promise<boolean> {
  const filePath = getStoreFilePath();
  try {
    await readFile(filePath, "utf-8");
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Check the current status of the API key store.
 */
export async function getApiKeyStoreStatus(): Promise<ApiKeyStoreStatus> {
  if (derivedKey && decryptedKeys && storeMetadata) {
    const providers: ApiKeyInfo[] = [];
    for (const [providerId, meta] of storeMetadata) {
      providers.push({
        providerId,
        label: meta.label,
        hasKey: decryptedKeys.has(providerId),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      });
    }
    return { state: "unlocked", providerCount: providers.length, providers };
  }

  const exists = await storeFileExists();
  if (!exists) {
    return { state: "empty" };
  }

  // Load just the metadata (provider count) without decrypting
  const persisted = await readPersistedStore();
  if (!persisted) {
    return { state: "empty" };
  }

  return { state: "locked", providerCount: Object.keys(persisted.keys).filter(k => k !== "__verify__").length };
}

/**
 * Initialize a new API key store with a master passphrase.
 * Throws if a store already exists.
 */
export async function initApiKeyStore(passphrase: string): Promise<void> {
  const exists = await storeFileExists();
  if (exists) {
    throw new Error("API key store already exists. Use unlockApiKeyStore() instead.");
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(passphrase, salt);

  // Store a verification token so we can detect wrong passphrases
  // even when no user keys have been added yet.
  const verifyEncrypted = encryptValue(key, "OK");
  const verifyEntry: EncryptedKeyEntry = {
    iv: verifyEncrypted.iv,
    authTag: verifyEncrypted.authTag,
    ciphertext: verifyEncrypted.ciphertext,
    providerId: "__verify__",
    label: "verification",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Save store to disk with verification token
  const store: ApiKeyStorePersisted = {
    version: APIKEY_STORE_VERSION,
    salt: salt.toString("base64"),
    keys: { __verify__: verifyEntry },
  };
  await writePersistedStore(store);

  // Set in-memory state (don't expose the verification token as a user key)
  derivedKey = key;
  decryptedKeys = new Map();
  storeMetadata = new Map();
  persistedSalt = store.salt;
}

/**
 * Unlock the API key store with the master passphrase.
 * Decrypts all keys into memory.
 * Returns ApiKeyInfo for all stored keys.
 */
export async function unlockApiKeyStore(passphrase: string): Promise<ApiKeyInfo[]> {
  if (derivedKey) {
    // Already unlocked
    const infos: ApiKeyInfo[] = [];
    if (storeMetadata) {
      for (const [providerId, meta] of storeMetadata) {
        infos.push({
          providerId,
          label: meta.label,
          hasKey: decryptedKeys?.has(providerId) ?? false,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
        });
      }
    }
    return infos;
  }

  const persisted = await readPersistedStore();
  if (!persisted) {
    throw new Error("No API key store found. Use initApiKeyStore() first.");
  }

  const salt = Buffer.from(persisted.salt, "base64");
  const key = await deriveKey(passphrase, salt);

  // Verify the key by attempting to decrypt the first entry
  const entries = Object.entries(persisted.keys);
  if (entries.length > 0) {
    try {
      const [_, firstEntry] = entries[0]!;
      decryptValue(key, firstEntry.iv, firstEntry.authTag, firstEntry.ciphertext);
    } catch {
      throw new Error("Invalid passphrase — failed to decrypt stored keys.");
    }
  }

  // Decrypt all keys into memory
  const keys = new Map<string, string>();
  const metadata = new Map<string, { label: string; createdAt: number; updatedAt: number }>();
  const infos: ApiKeyInfo[] = [];

  for (const [providerId, entry] of Object.entries(persisted.keys)) {
    // Skip internal verification token
    if (providerId === "__verify__") continue;

    try {
      const plaintext = decryptValue(key, entry.iv, entry.authTag, entry.ciphertext);
      keys.set(providerId, plaintext);
    } catch {
      // Skip corrupted entries
      continue;
    }
    metadata.set(providerId, {
      label: entry.label,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
    infos.push({
      providerId,
      label: entry.label,
      hasKey: true,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }

  derivedKey = key;
  decryptedKeys = keys;
  storeMetadata = metadata;
  persistedSalt = persisted.salt;

  return infos;
}

/**
 * Lock the API key store, clearing all decrypted keys from memory.
 */
export function lockApiKeyStore(): void {
  derivedKey = null;
  decryptedKeys = null;
  storeMetadata = null;
  // Keep persistedSalt so we can re-derive without reading disk on unlock
}

/**
 * Check if the store is currently unlocked.
 */
export function isApiKeyStoreUnlocked(): boolean {
  return derivedKey !== null && decryptedKeys !== null;
}

/**
 * List all provider IDs that have keys stored (without their values).
 */
export function listApiKeyProviders(): ApiKeyInfo[] {
  if (!storeMetadata) {
    return [];
  }
  const infos: ApiKeyInfo[] = [];
  for (const [providerId, meta] of storeMetadata) {
    if (providerId === "__verify__") continue;
    infos.push({
      providerId,
      label: meta.label,
      hasKey: decryptedKeys?.has(providerId) ?? false,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    });
  }
  return infos;
}

/**
 * Get a decrypted API key for a provider.
 * Returns null if the provider has no stored key or the store is locked.
 */
export function getApiKey(providerId: string): string | null {
  if (!decryptedKeys) return null;
  return decryptedKeys.get(providerId) ?? null;
}

/**
 * Get a masked version of the API key for display (e.g. "sk-...abc123").
 */
export function getMaskedApiKey(providerId: string): string | null {
  const key = getApiKey(providerId);
  if (!key) return null;

  if (key.length <= 8) return "*".repeat(key.length);

  const prefix = key.slice(0, 4);
  const suffix = key.slice(-4);
  return `${prefix}...${suffix}`;
}

/**
 * Store (create or update) an API key for a provider.
 * Requires the store to be unlocked.
 */
export async function setApiKey(
  providerId: string,
  apiKey: string,
  label?: string,
): Promise<void> {
  if (providerId === "__verify__") {
    throw new Error("Reserved provider ID: __verify__");
  }
  if (!derivedKey || !decryptedKeys || !storeMetadata) {
    throw new Error("API key store is locked. Call unlockApiKeyStore() first.");
  }

  const now = Date.now();
  const existingMeta = storeMetadata.get(providerId);

  // Encrypt the new key
  const encrypted = encryptValue(derivedKey, apiKey);

  // Update in-memory
  decryptedKeys.set(providerId, apiKey);
  storeMetadata.set(providerId, {
    label: label ?? existingMeta?.label ?? providerId,
    createdAt: existingMeta?.createdAt ?? now,
    updatedAt: now,
  });

  // Persist to disk
  const persisted = await readPersistedStore();
  if (!persisted) {
    throw new Error("Store file missing. Re-initialize with initApiKeyStore().");
  }

  const meta = storeMetadata.get(providerId)!;
  persisted.keys[providerId] = {
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    ciphertext: encrypted.ciphertext,
    providerId,
    label: meta.label,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };

  await writePersistedStore(persisted);
}

/**
 * Delete an API key for a provider.
 * Requires the store to be unlocked.
 * Returns true if a key was deleted, false if none existed.
 */
export async function deleteApiKey(providerId: string): Promise<boolean> {
  if (!derivedKey || !decryptedKeys || !storeMetadata) {
    throw new Error("API key store is locked. Call unlockApiKeyStore() first.");
  }

  if (!decryptedKeys.has(providerId)) return false;

  decryptedKeys.delete(providerId);
  storeMetadata.delete(providerId);

  const persisted = await readPersistedStore();
  if (persisted && persisted.keys[providerId]) {
    delete persisted.keys[providerId];
    await writePersistedStore(persisted);
  }

  return true;
}

/**
 * Change the master passphrase. Re-encrypts all keys with the new passphrase.
 * Requires the store to be unlocked.
 */
export async function changeApiKeyStorePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
): Promise<void> {
  if (!derivedKey || !decryptedKeys || !storeMetadata) {
    // Try to unlock with old passphrase first
    await unlockApiKeyStore(oldPassphrase);
  }

  if (!derivedKey || !decryptedKeys || !storeMetadata) {
    throw new Error("API key store is locked. Call unlockApiKeyStore() first.");
  }

  // Verify old passphrase by re-deriving and comparing
  if (persistedSalt) {
    const oldSalt = Buffer.from(persistedSalt, "base64");
    const oldKey = await deriveKey(oldPassphrase, oldSalt);
    if (!timingSafeEqual(derivedKey, oldKey)) {
      throw new Error("Old passphrase does not match.");
    }
  }

  // Generate new salt and key
  const newSalt = randomBytes(SALT_LENGTH);
  const newKey = await deriveKey(newPassphrase, newSalt);

  // Re-encrypt all keys
  const newStore: ApiKeyStorePersisted = {
    version: APIKEY_STORE_VERSION,
    salt: newSalt.toString("base64"),
    keys: {},
  };

  for (const [providerId, plaintext] of decryptedKeys) {
    const meta = storeMetadata.get(providerId);
    const encrypted = encryptValue(newKey, plaintext);
    newStore.keys[providerId] = {
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
      providerId,
      label: meta?.label ?? providerId,
      createdAt: meta?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
  }

  await writePersistedStore(newStore);

  // Update in-memory state
  derivedKey = newKey;
  persistedSalt = newStore.salt;
}

/**
 * Delete the entire API key store (both on-disk and in-memory).
 * This is irreversible — all stored keys will be lost.
 */
export async function destroyApiKeyStore(): Promise<void> {
  lockApiKeyStore();
  persistedSalt = null;

  const filePath = getStoreFilePath();
  try {
    await rm(filePath, { force: true });
  } catch {
    // best-effort
  }
}

// =============================================================================
// Export/Import (raw data for sync — encryption handled by apikey-sync.ts)
// =============================================================================

/**
 * Get the raw persisted store (encrypted) for export/sync purposes.
 * Requires store to be unlocked (so we know the data is valid).
 */
export async function getRawPersistedStore(): Promise<ApiKeyStorePersisted | null> {
  return readPersistedStore();
}

/**
 * Write a raw persisted store to disk. Used for import.
 */
export async function writeRawPersistedStore(store: ApiKeyStorePersisted): Promise<void> {
  await writePersistedStore(store);
  // Note: does NOT update in-memory state — caller should re-unlock
}

/**
 * Get the persisted salt for external use.
 */
export function getPersistedSalt(): string | null {
  return persistedSalt;
}
