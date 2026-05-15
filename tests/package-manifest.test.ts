import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as {
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, { default?: string; types?: string }>;
  "oc-plugin"?: string[];
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
};

const pnpmWorkspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");

describe("package manifest compatibility", () => {
  it("pins pnpm development tooling without raising runtime Node support", () => {
    expect(pkg.packageManager).toBe("pnpm@11.0.0");
    expect(pkg.engines?.node).toBe(">=18.0.0");
  });

  it("hardens pnpm dependency resolution against fresh-package supply-chain attacks", () => {
    expect(pnpmWorkspace).toContain("minimumReleaseAge: 1440");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeStrict: true");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeIgnoreMissingTime: false");
    expect(pnpmWorkspace).toContain("blockExoticSubdeps: true");
    expect(pnpmWorkspace).toContain("onlyBuiltDependencies:");
  });

  it("ships explicit server, tui, and init bin entrypoints for OpenCode", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.bin).toEqual({
      "opencode-quota": "./dist/bin/opencode-quota.js",
    });
    expect(pkg["oc-plugin"]).toEqual(["server", "tui"]);
    expect(pkg.dependencies?.["@clack/prompts"]).toBeTruthy();
    expect(pkg.exports?.["."]).toEqual({
      default: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./server"]).toEqual({
      default: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./tui"]).toEqual({
      default: "./dist/tui.tsx",
      types: "./dist/tui.d.ts",
    });
  });
});
