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

describe("google gemini cli companion resolution", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    moduleMocks.resolveImpl.mockReset();
    moduleMocks.runtimeDirs.value = { cacheDirs: [] };
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-gemini-companion-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports missing when the companion package cannot be resolved", async () => {
    moduleMocks.resolveImpl.mockImplementation(() => {
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-gemini-cli-companion.js");

    await expect(mod.inspectGeminiCliCompanionPresence()).resolves.toMatchObject({
      state: "missing",
    });
    await expect(mod.resolveGeminiCliClientCredentials()).resolves.toMatchObject({
      state: "missing",
    });
  });

  it("reads credentials from the published source constants file", async () => {
    const constantsPath = join(tempDir, "constants.ts");
    writeFileSync(
      constantsPath,
      [
        "export const GEMINI_CLIENT_ID = 'client-id';",
        "export const GEMINI_CLIENT_SECRET = 'client-secret';",
      ].join("\n"),
      "utf8",
    );
    moduleMocks.resolveImpl.mockImplementation((specifier) => {
      if (specifier === "opencode-gemini-auth/src/constants.ts") {
        return constantsPath;
      }
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-gemini-cli-companion.js");

    await expect(mod.inspectGeminiCliCompanionPresence()).resolves.toMatchObject({
      state: "present",
      resolvedPath: constantsPath,
    });
    await expect(mod.resolveGeminiCliClientCredentials()).resolves.toMatchObject({
      state: "configured",
      clientId: "client-id",
      clientSecret: "client-secret",
      resolvedPath: constantsPath,
    });
  });

  it("resolves source constants from OpenCode runtime cache node_modules", async () => {
    const runtimeCacheDir = join(tempDir, "cache", "opencode");
    const constantsPath = join(runtimeCacheDir, "node_modules", "opencode-gemini-auth", "src", "constants.ts");
    mkdirSync(join(runtimeCacheDir, "node_modules", "opencode-gemini-auth", "src"), { recursive: true });
    writeFileSync(
      constantsPath,
      [
        "export const GEMINI_CLIENT_ID = 'runtime-client-id';",
        "export const GEMINI_CLIENT_SECRET = 'runtime-client-secret';",
      ].join("\n"),
      "utf8",
    );
    moduleMocks.runtimeDirs.value = { cacheDirs: [runtimeCacheDir] };
    moduleMocks.resolveImpl.mockImplementation(() => {
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-gemini-cli-companion.js");

    await expect(mod.resolveGeminiCliClientCredentials()).resolves.toMatchObject({
      state: "configured",
      clientId: "runtime-client-id",
      clientSecret: "runtime-client-secret",
      resolvedPath: constantsPath,
    });
  });

  it("reports invalid when the source constants file is missing usable credentials", async () => {
    const constantsPath = join(tempDir, "constants.ts");
    writeFileSync(constantsPath, "export const GEMINI_CLIENT_ID = '';\n", "utf8");
    moduleMocks.resolveImpl.mockImplementation((specifier) => {
      if (specifier === "opencode-gemini-auth/src/constants.ts") {
        return constantsPath;
      }
      throw moduleNotFound();
    });

    const mod = await import("../src/lib/google-gemini-cli-companion.js");

    await expect(mod.inspectGeminiCliCompanionPresence()).resolves.toMatchObject({
      state: "invalid",
      resolvedPath: constantsPath,
    });
    await expect(mod.resolveGeminiCliClientCredentials()).resolves.toMatchObject({
      state: "invalid",
      resolvedPath: constantsPath,
    });
  });
});
