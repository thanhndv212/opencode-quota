import { readFile } from "fs/promises";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

const require = createRequire(import.meta.url);

const COMPANION_PACKAGE_NAME = "@anthonyhaussman/opencode-agy-auth";
const COMPANION_JS_IMPORT_SPECIFIERS = [
  `${COMPANION_PACKAGE_NAME}/dist/src/constants.js`,
  `${COMPANION_PACKAGE_NAME}/src/constants.js`,
] as const;
const COMPANION_SOURCE_IMPORT_SPECIFIER = `${COMPANION_PACKAGE_NAME}/src/constants.ts`;
const COMPANION_PACKAGE_JSON_SPECIFIER = `${COMPANION_PACKAGE_NAME}/package.json`;
const COMPANION_DIRECT_CANDIDATE_PATHS = [
  ["src", "constants.ts"],
  ["src", "constants.js"],
  ["dist", "src", "constants.js"],
  ["dist", "index.js"],
] as const;
const COMPANION_MISSING_ERROR = `Install ${COMPANION_PACKAGE_NAME} separately to enable Google AGY quota`;
const COMPANION_INVALID_ERROR = `Installed ${COMPANION_PACKAGE_NAME} package is incompatible`;

export type AgyCompanionPresence =
  | {
      state: "present";
      importSpecifier: string;
      resolvedPath: string;
    }
  | {
      state: "missing";
      importSpecifier: string;
      error: string;
    }
  | {
      state: "invalid";
      importSpecifier: string;
      error: string;
      resolvedPath?: string;
    };

export type AgyConfiguredCredentials = {
  state: "configured";
  clientId: string;
  clientSecret: string;
  resolvedPath: string;
};

export type AgyClientCredentials =
  | AgyConfiguredCredentials
  | {
      state: "missing" | "invalid";
      error: string;
      resolvedPath?: string;
    };

type ResolvedCompanionState = {
  presence: AgyCompanionPresence;
  credentials: AgyClientCredentials;
};

type CompanionModule = {
  AGY_CLIENT_ID?: unknown;
  AGY_CLIENT_SECRET?: unknown;
};

type CompanionResolutionContext = {
  packageFound: boolean;
};

let resolvedCompanionStatePromise: Promise<ResolvedCompanionState> | null = null;

function isModuleNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  if (code === "MODULE_NOT_FOUND") {
    return true;
  }

  const message = error instanceof Error ? error.message : "";
  return message.includes("Cannot find module");
}

function isPackagePathNotExportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  return "code" in error && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

function isFallthroughResolutionError(error: unknown): boolean {
  return isModuleNotFoundError(error) || isPackagePathNotExportedError(error);
}

function normalizeCredential(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getCompanionResolvePaths(): string[] {
  const paths = [...getOpencodeRuntimeDirCandidates().cacheDirs];
  return paths;
}

function getRuntimePackageRoots(): string[] {
  const cacheDirs = getOpencodeRuntimeDirCandidates().cacheDirs;
  const packageRoots = cacheDirs.map((cacheDir) =>
    join(cacheDir, "node_modules", COMPANION_PACKAGE_NAME),
  );

  for (const cacheDir of cacheDirs) {
    try {
      const packagesDir = join(cacheDir, "packages");
      if (COMPANION_PACKAGE_NAME.startsWith("@")) {
        const [scope, name] = COMPANION_PACKAGE_NAME.split("/");
        const scopeDir = join(packagesDir, scope);
        const entries = readdirSync(scopeDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith(name)) {
            const packagePath = join(scopeDir, entry.name);
            packageRoots.push(packagePath);
            packageRoots.push(join(packagePath, "node_modules", COMPANION_PACKAGE_NAME));
          }
        }
      } else {
        const entries = readdirSync(packagesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith(COMPANION_PACKAGE_NAME)) {
            packageRoots.push(join(packagesDir, entry.name));
            packageRoots.push(join(packagesDir, entry.name, "node_modules", COMPANION_PACKAGE_NAME));
          }
        }
      }
    } catch {
      // Ignore if packages dir doesn't exist
    }
  }

  return packageRoots;
}

function markPackageFoundForExportBlock(error: unknown, context: CompanionResolutionContext): void {
  if (isPackagePathNotExportedError(error)) {
    context.packageFound = true;
  }
}

function resolveCompanionSpecifier(specifier: string, context: CompanionResolutionContext): string {
  try {
    return require.resolve(specifier);
  } catch (error) {
    markPackageFoundForExportBlock(error, context);
    if (!isFallthroughResolutionError(error)) {
      throw error;
    }

    try {
      return require.resolve(specifier, { paths: getCompanionResolvePaths() });
    } catch (resolvePathsError) {
      markPackageFoundForExportBlock(resolvePathsError, context);
      throw resolvePathsError;
    }
  }
}

function buildConfiguredState(params: {
  importSpecifier: string;
  resolvedPath: string;
  clientId: string;
  clientSecret: string;
}): ResolvedCompanionState {
  return {
    presence: {
      state: "present",
      importSpecifier: params.importSpecifier,
      resolvedPath: params.resolvedPath,
    },
    credentials: {
      state: "configured",
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      resolvedPath: params.resolvedPath,
    },
  };
}

function buildInvalidState(importSpecifier: string, resolvedPath?: string): ResolvedCompanionState {
  return {
    presence: {
      state: "invalid",
      importSpecifier,
      ...(resolvedPath ? { resolvedPath } : {}),
      error: COMPANION_INVALID_ERROR,
    },
    credentials: {
      state: "invalid",
      ...(resolvedPath ? { resolvedPath } : {}),
      error: COMPANION_INVALID_ERROR,
    },
  };
}

function parseSourceCredentials(
  content: string,
): { clientId: string; clientSecret: string } | null {
  const clientId =
    content
      .match(/(?:export\s+const|const|var)\s+AGY_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1]
      ?.trim() ?? "";
  const clientSecret =
    content
      .match(/(?:export\s+const|const|var)\s+AGY_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1]
      ?.trim() ?? "";

  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function getPackageCredentialPaths(packageRoot: string): string[] {
  return COMPANION_DIRECT_CANDIDATE_PATHS.map((parts) => join(packageRoot, ...parts));
}

function getRuntimeSourceConstantPaths(): string[] {
  return getRuntimePackageRoots().flatMap((packageRoot) => getPackageCredentialPaths(packageRoot));
}

async function tryReadSourceConstantsPath(
  resolvedPath: string,
): Promise<ResolvedCompanionState | null> {
  try {
    const content = await readFile(resolvedPath, "utf8");
    const credentials = parseSourceCredentials(content);
    if (!credentials) {
      return buildInvalidState(COMPANION_SOURCE_IMPORT_SPECIFIER, resolvedPath);
    }
    return buildConfiguredState({
      importSpecifier: COMPANION_SOURCE_IMPORT_SPECIFIER,
      resolvedPath,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
  } catch {
    return null;
  }
}

async function tryResolveJsConstants(
  importSpecifier: string,
  context: CompanionResolutionContext,
): Promise<ResolvedCompanionState | null> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveCompanionSpecifier(importSpecifier, context);
  } catch (error) {
    if (isFallthroughResolutionError(error)) {
      return null;
    }
    return buildInvalidState(importSpecifier);
  }

  let companionModule: CompanionModule;
  try {
    companionModule = (await import(pathToFileURL(resolvedPath).href)) as CompanionModule;
  } catch {
    return buildInvalidState(importSpecifier, resolvedPath);
  }

  const clientId = normalizeCredential(companionModule.AGY_CLIENT_ID);
  const clientSecret = normalizeCredential(companionModule.AGY_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    return buildInvalidState(importSpecifier, resolvedPath);
  }

  return buildConfiguredState({ importSpecifier, resolvedPath, clientId, clientSecret });
}

async function tryResolvePackageEntry(
  context: CompanionResolutionContext,
): Promise<ResolvedCompanionState | null> {
  try {
    const packageEntryPath = resolveCompanionSpecifier(COMPANION_PACKAGE_NAME, context);
    const packageEntryResolved = await tryReadSourceConstantsPath(packageEntryPath);
    return packageEntryResolved ?? buildInvalidState(COMPANION_PACKAGE_NAME, packageEntryPath);
  } catch (error) {
    return isFallthroughResolutionError(error) ? null : buildInvalidState(COMPANION_PACKAGE_NAME);
  }
}

async function tryResolveSourceConstants(
  context: CompanionResolutionContext,
): Promise<ResolvedCompanionState | null> {
  let resolvedPath: string;
  try {
    resolvedPath = require.resolve(COMPANION_SOURCE_IMPORT_SPECIFIER);
  } catch (error) {
    if (!isFallthroughResolutionError(error)) {
      return buildInvalidState(COMPANION_SOURCE_IMPORT_SPECIFIER);
    }

    for (const candidatePath of getRuntimeSourceConstantPaths()) {
      const runtimeResolved = await tryReadSourceConstantsPath(candidatePath);
      if (runtimeResolved) {
        return runtimeResolved;
      }
    }

    try {
      const packageJsonPath = resolveCompanionSpecifier(COMPANION_PACKAGE_JSON_SPECIFIER, context);
      const packageRoot = dirname(packageJsonPath);
      for (const candidatePath of [
        join(packageRoot, "src", "constants.ts"),
        join(packageRoot, "dist", "index.js"),
      ]) {
        const packageResolved = await tryReadSourceConstantsPath(candidatePath);
        if (packageResolved) {
          return packageResolved;
        }
      }
      resolvedPath = join(packageRoot, "src", "constants.ts");
    } catch (packageError) {
      if (isFallthroughResolutionError(packageError)) {
        return tryResolvePackageEntry(context);
      }

      return buildInvalidState(COMPANION_SOURCE_IMPORT_SPECIFIER);
    }
  }

  return (
    (await tryReadSourceConstantsPath(resolvedPath)) ??
    buildInvalidState(COMPANION_SOURCE_IMPORT_SPECIFIER, resolvedPath)
  );
}

async function resolveCompanionState(): Promise<ResolvedCompanionState> {
  const context: CompanionResolutionContext = { packageFound: false };

  for (const importSpecifier of COMPANION_JS_IMPORT_SPECIFIERS) {
    const resolved = await tryResolveJsConstants(importSpecifier, context);
    if (resolved) {
      return resolved;
    }
  }

  const sourceResolved = await tryResolveSourceConstants(context);
  if (sourceResolved) {
    return sourceResolved;
  }

  if (context.packageFound) {
    return buildInvalidState(COMPANION_PACKAGE_NAME);
  }

  return {
    presence: {
      state: "missing",
      importSpecifier: COMPANION_SOURCE_IMPORT_SPECIFIER,
      error: COMPANION_MISSING_ERROR,
    },
    credentials: {
      state: "missing",
      error: COMPANION_MISSING_ERROR,
    },
  };
}

async function getResolvedCompanionState(): Promise<ResolvedCompanionState> {
  if (!resolvedCompanionStatePromise) {
    resolvedCompanionStatePromise = resolveCompanionState();
  }
  return resolvedCompanionStatePromise;
}

export async function inspectAgyCompanionPresence(): Promise<AgyCompanionPresence> {
  const resolved = await getResolvedCompanionState();
  return resolved.presence;
}

export async function resolveAgyClientCredentials(): Promise<AgyClientCredentials> {
  const resolved = await getResolvedCompanionState();
  return resolved.credentials;
}

export function clearAgyCompanionCacheForTests(): void {
  resolvedCompanionStatePromise = null;
}
