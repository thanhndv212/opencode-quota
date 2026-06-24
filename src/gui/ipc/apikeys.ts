/**
 * IPC handlers for encrypted API key management.
 * Wraps apikey-store.ts and apikey-sync.ts.
 */

import {
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
  getApiKeyStoreStatus,
  destroyApiKeyStore,
  type ApiKeyInfo,
  type ApiKeyStoreStatus,
} from "../../lib/apikey-store.js";
import {
  createApiKeyShareBundle,
  decryptApiKeyShareBundle,
  readApiKeyShareBundle,
  writeApiKeyShareBundle,
  deleteApiKeyShareFile,
  type ApiKeyShareEntry,
  type ApiKeyImportResult,
} from "../../lib/apikey-sync.js";

// =============================================================================
// Store management
// =============================================================================

export async function getStatus(): Promise<ApiKeyStoreStatus> {
  return getApiKeyStoreStatus();
}

export async function initStore(passphrase: string): Promise<void> {
  return initApiKeyStore(passphrase);
}

export async function unlockStore(passphrase: string): Promise<ApiKeyInfo[]> {
  return unlockApiKeyStore(passphrase);
}

export function lockStore(): void {
  lockApiKeyStore();
}

export function isUnlocked(): boolean {
  return isApiKeyStoreUnlocked();
}

// =============================================================================
// Key CRUD
// =============================================================================

export function listKeys(): ApiKeyInfo[] {
  return listApiKeyProviders();
}

export function getKey(providerId: string): string | null {
  return getApiKey(providerId);
}

export function getMasked(providerId: string): string | null {
  return getMaskedApiKey(providerId);
}

export async function saveKey(providerId: string, apiKey: string, label?: string): Promise<void> {
  return setApiKey(providerId, apiKey, label);
}

export async function removeKey(providerId: string): Promise<boolean> {
  return deleteApiKey(providerId);
}

// =============================================================================
// Passphrase management
// =============================================================================

export async function changePassphrase(oldPass: string, newPass: string): Promise<void> {
  return changeApiKeyStorePassphrase(oldPass, newPass);
}

export async function destroyStore(): Promise<void> {
  return destroyApiKeyStore();
}

// =============================================================================
// Export/Import
// =============================================================================

export async function exportKeys(
  sharePassphrase: string,
): Promise<{ bundle: object; defaultFileName: string }> {
  if (!isApiKeyStoreUnlocked()) {
    throw new Error("API key store is locked. Unlock it first.");
  }

  const infos = listApiKeyProviders();
  const entries: ApiKeyShareEntry[] = [];

  for (const info of infos) {
    const key = getApiKey(info.providerId);
    if (key) {
      entries.push({
        providerId: info.providerId,
        label: info.label,
        key,
      });
    }
  }

  if (entries.length === 0) {
    throw new Error("No API keys to export.");
  }

  const bundle = await createApiKeyShareBundle(entries, sharePassphrase);
  return {
    bundle,
    defaultFileName: "opencode-quota-apikeys.share",
  };
}

export async function importKeys(
  filePath: string,
  sharePassphrase: string,
): Promise<ApiKeyImportResult> {
  if (!isApiKeyStoreUnlocked()) {
    throw new Error("API key store is locked. Unlock it first.");
  }

  const getLocalKey = (providerId: string): string | null => {
    return getApiKey(providerId);
  };

  const setLocalKey = async (providerId: string, apiKey: string, label: string): Promise<void> => {
    await setApiKey(providerId, apiKey, label);
  };

  const { importApiKeyShareFile } = await import("../../lib/apikey-sync.js");
  return importApiKeyShareFile(filePath, sharePassphrase, getLocalKey, setLocalKey);
}
