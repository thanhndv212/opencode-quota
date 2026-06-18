import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const moduleMocks = vi.hoisted(() => ({
  resolveImpl: vi.fn<(specifier: string, options?: { paths?: string[] }) => string>(),
  runtimeDirs: {
    value: {
      cacheDirs: [] as string[],
    },
  },
}));

vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: moduleMocks.resolveImpl,
  }),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => moduleMocks.runtimeDirs.value,
}));

function moduleNotFound(): Error & { code?: string } {
  const error = new Error("Cannot find module");
  error.code = "MODULE_NOT_FOUND";
  return error;
}

function packagePathNotExported(): Error & { code?: string } {
  const error = new Error('Package subpath is not defined by "exports"');
  error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
  return error;
}

function writeAgyCredentials(
  path: string,
  params?: { declaration?: "export const" | "const" | "var" },
): void {
  const declaration = params?.declaration ?? "export const";
  writeFileSync(
    path,
    [
      `${declaration} AGY_CLIENT_ID = 'client-id';`,
      `${declaration} AGY_CLIENT_SECRET = 'client-secret';`,
    ].join("\n"),
    "utf8",
  );
}

describe("google agy companion resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    moduleMocks.resolveImpl.mockReset();
    moduleMocks.runtimeDirs.value = { cacheDirs: [] };
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-agy-companion-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports missing when the companion package cannot be resolved", async () => {
    moduleMocks.resolveImpl.mockImplementation(() => {
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-agy-companion.js");

    await expect(mod.inspectAgyCompanionPresence()).resolves.toMatchObject({
      state: "missing",
    });
    await expect(mod.resolveAgyClientCredentials()).resolves.toMatchObject({
      state: "missing",
    });
  });

  it("reads credentials from the published source constants file", async () => {
    const constantsPath = join(tempDir, "constants.ts");
    writeFileSync(
      constantsPath,
      [
        "export const AGY_CLIENT_ID = 'client-id';",
        "export const AGY_CLIENT_SECRET = 'client-secret';",
      ].join("\n"),
      "utf8",
    );
    moduleMocks.resolveImpl.mockImplementation((specifier) => {
      if (specifier === "@anthonyhaussman/opencode-agy-auth/src/constants.ts") {
        return constantsPath;
      }
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-agy-companion.js");

    await expect(mod.inspectAgyCompanionPresence()).resolves.toMatchObject({
      state: "present",
      resolvedPath: constantsPath,
    });
    await expect(mod.resolveAgyClientCredentials()).resolves.toMatchObject({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
      resolvedPath: constantsPath,
    });
  });

  it("reads credentials from the bundled dist file", async () => {
    const packageRoot = join(tempDir, "@anthonyhaussman/opencode-agy-auth");
    const packageJsonPath = join(packageRoot, "package.json");
    const distPath = join(packageRoot, "dist", "index.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(packageJsonPath, JSON.stringify({ name: "@anthonyhaussman/opencode-agy-auth" }), "utf8");
    writeFileSync(
      distPath,
      [
        "var AGY_CLIENT_ID = 'dist-client-id';",
        "var AGY_CLIENT_SECRET = 'dist-client-secret';",
      ].join("\n"),
      "utf8",
    );
    moduleMocks.resolveImpl.mockImplementation((specifier) => {
      if (specifier === "@anthonyhaussman/opencode-agy-auth/package.json") {
        return packageJsonPath;
      }
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-agy-companion.js");

    await expect(mod.resolveAgyClientCredentials()).resolves.toMatchObject({
      state: "configured",
      clientId: "dist-client-id",
      clientSecret: "dist-client-secret",
      resolvedPath: distPath,
    });
  });

  it("falls through package export blocks and reads credentials from the package root export", async () => {
    const packageRoot = join(tempDir, "@anthonyhaussman/opencode-agy-auth");
    const distPath = join(packageRoot, "dist", "index.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      distPath,
      [
        "var AGY_CLIENT_ID = 'export-client-id';",
        "var AGY_CLIENT_SECRET = 'export-client-secret';",
      ].join("\n"),
      "utf8",
    );
    moduleMocks.resolveImpl.mockImplementation((specifier) => {
      if (specifier === "@anthonyhaussman/opencode-agy-auth") {
        return distPath;
      }
      if (specifier.startsWith("@anthonyhaussman/opencode-agy-auth/")) {
        throw packagePathNotExported();
      }
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-agy-companion.js");

    await expect(mod.resolveAgyClientCredentials()).resolves.toMatchObject({
      state: "configured",
      clientId: "export-client-id",
      clientSecret: "export-client-secret",
      resolvedPath: distPath,
    });
  });

  it("reports invalid when package export blocks prove the package exists but no fallback resolves", async () => {
    moduleMocks.resolveImpl.mockImplementation((specifier) => {
      if (specifier.startsWith("@anthonyhaussman/opencode-agy-auth/")) {
        throw packagePathNotExported();
      }
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-agy-companion.js");

    await expect(mod.inspectAgyCompanionPresence()).resolves.toMatchObject({
      state: "invalid",
    });
    await expect(mod.resolveAgyClientCredentials()).resolves.toMatchObject({
      state: "invalid",
    });
  });

  it("reads credentials from a nested node_modules structure in runtime packages directory", async () => {
    const runtimeCacheDir = join(tempDir, "cache", "opencode");
    const packageRoot = join(runtimeCacheDir, "packages", "@anthonyhaussman/opencode-agy-auth-1.0.0");
    const nestedRoot = join(packageRoot, "node_modules", "@anthonyhaussman/opencode-agy-auth");
    const distPath = join(nestedRoot, "dist", "index.js");
    mkdirSync(join(nestedRoot, "dist"), { recursive: true });
    writeAgyCredentials(distPath, { declaration: "var" });
    moduleMocks.runtimeDirs.value = { cacheDirs: [runtimeCacheDir] };
    moduleMocks.resolveImpl.mockImplementation(() => {
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-agy-companion.js");

    await expect(mod.resolveAgyClientCredentials()).resolves.toMatchObject({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
      resolvedPath: distPath,
    });
  });
});
